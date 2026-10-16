"use agent"
import { env } from "cloudflare:workers"
import { getSandbox, OperationInterruptedError } from "@cloudflare/sandbox"
import {
  CompletionReport,
  FactSnapshot,
  InformationRequest,
  RuntimeSpec,
} from "@workspace/contracts"
import {
  assignments,
  eq,
  events,
  sql,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import {
  type AgentProps,
  type BudgetGuard,
  completeOnce,
  createBudgetGuard,
  createMutationQueue,
  createTee,
  createTurnGate,
  defineTool,
  guardedTools,
  instrument,
  type MutationQueue,
  observe,
  type ResolvedRuntime,
  registerProviders,
  resolveRuntime,
  roleOf,
  SANDBOX_UPDATING,
  type Tee,
  type TurnGate,
  toolInput,
  useAgentStart,
  useDelivery,
  useInitialData,
  useModel,
  usePersistentState,
  useResponseFinish,
  useSandbox,
  useTool,
  withOutputCap,
} from "@workspace/facade"
import { cloudflareSandbox } from "@workspace/facade/cloudflare"
import { z } from "zod"
import type { Brief } from "../brief.ts"
import {
  copyInstructions,
  FAN_OUT,
  fansOut,
  fieldsOfPrompt,
  pageInstructions,
  pageOfPrompt,
  serviceCount,
  writerTasks,
} from "../fanout.ts"
import { placeGenerated } from "../images.ts"
import { instructions, sectionInstructions } from "../instructions.ts"
import {
  ASK_CHIEF_DESCRIPTION,
  AskChiefInput,
  askedOptions,
  refuseQuestion,
} from "../question.ts"
import { logTurn } from "../quick.ts"
import { placePhotos, SITE_ROOT } from "../revise.ts"
import { checkpoint, recover } from "../sandbox.ts"
import { QUOTE_FORM_FILE, quoteFormFile, seedFiles } from "../seed.ts"
import { eventSink } from "../sink.ts"
import { assignmentCost, turnCount } from "../state.ts"
import { checksOf, finishRevision, GIT, SEAL_PHOTOS } from "../tail.ts"
import { LEAD_TURN_MS, since } from "../timing.ts"
import {
  createWarmer,
  followPhotos,
  type Landed,
  landedOf,
  reconcilePhotos,
  replySchema,
  WARM_BUILD,
  writePages,
} from "../write-pages.ts"

/**
 * The Developer (§8, ADR-031): one Durable Object conversation per
 * assignment, a container that is a filesystem and a shell, tools that write
 * to the Workflow and never to the container's network. The spec is verified
 * before any hook renders; every runtime event is teed into the log; the
 * budget guard sits in front of every model call.
 */

const POLICY = { siteRoot: SITE_ROOT, readOnlyRoots: ["/opt/astro"] }

// The transport, once per isolate; a missing key fails here, before a model.
registerProviders(env)

/** What this isolate knows about its conversation, keyed by instance id. */
type Session = {
  tee: Tee
  budget: BudgetGuard
  runtime: ResolvedRuntime
  kit: Tenancy
  brief: Brief
  gate: TurnGate
  /** One per assignment, so the lead's and every subagent's writes to one file take turns. */
  mutations: MutationQueue
  /** Operations already reported as interrupted, so one failure wakes the Workflow once. */
  interruptions: Set<string>
  budgetExhausted: boolean
}
const sessions = new Map<string, Session>()

// One tee and one budget guard per conversation, found by the instance id
// every event and interception carries. Registered once per isolate.
observe((observation, ctx) => {
  const found = sessions.get(ctx.id)
  if (!found) return
  found.tee.subscriber(observation)
  found.budget.instrumentation.observe(observation, ctx)
  interrupted(found, observation)
})

/**
 * A run that ends in an error (a provider stream that breaks, measured on
 * staging 2026-09-15) never calls a tool that wakes the Workflow, so without
 * this the assignment waits on an event that never comes and holds the site
 * lock. The log is flushed first, then the Workflow is told once per failed
 * operation; it retries and, failing that, releases the lock (§13). A budget
 * refusal is left to the budget path, which already wakes it. A subagent's
 * failed run is not one: it returns to the lead as its `task` result, and
 * the lead's turn goes on.
 */
function interrupted(found: Session, observation: unknown) {
  const o = observation as {
    type?: string
    operationId?: string
    taskId?: string
    error?: { meta?: { reason?: unknown }; name?: unknown }
  }
  if (o.type !== "operation" || !o.error || o.taskId || found.budgetExhausted)
    return
  const reason = String(
    o.error.meta?.reason ?? o.error.name ?? "operation failed"
  ).slice(0, 300)
  wake(found, o.operationId ?? "unknown", reason)
}

/**
 * Wake the Workflow once per key with an `interrupted` reason: an operation
 * that failed, or the turn gate ending the turn on the model's behalf
 * (open item 55). Or with `unreported`: the lead's turn ended with nothing
 * that woke it. The log gets the reason first, then the wake.
 */
function wake(
  found: Session,
  key: string,
  reason: string,
  kind: "interrupted" | "unreported" = "interrupted"
) {
  if (found.interruptions.has(key)) return
  found.interruptions.add(key)
  found.tee.emit(`developer.${kind}`, { reason })
  found.tee
    .flush()
    .then(() => workflow(found.brief.snapshot.assignment_id))
    .then((instance) =>
      instance.sendEvent({
        type: "developer",
        payload: { kind, reason },
      })
    )
    .catch(() => undefined)
}

/** The tools that wake the Workflow themselves when they succeed. */
const WAKING_TOOLS = new Set(["report_complete", "ask_chief"])

/**
 * The sandbox SDK's own class for a container the platform replaced under a
 * running command: the model cannot fix it, so the gate ends the turn at once
 * and the Workflow resumes when the runtime is back (architect ruling, open
 * item 55). The code check covers an error that lost its prototype crossing
 * a boundary; the message is never matched.
 */
const platformInterrupted = (error: unknown) =>
  error instanceof OperationInterruptedError ||
  (error as { code?: string }).code === "OPERATION_INTERRUPTED"
    ? SANDBOX_UPDATING
    : null
instrument({
  key: Symbol.for("reme.developer"),
  observe: () => undefined,
  interceptor: (operation, ctx, next) => {
    const found = ctx.instanceId ? sessions.get(ctx.instanceId) : undefined
    if (!found) return next()
    // The turn gate first: a refused tool call never reaches the budget.
    return found.gate.interceptor(operation, ctx, () =>
      found.budget.instrumentation.interceptor(operation, ctx, next)
    )
  },
  dispose() {
    sessions.clear()
  },
})

const sandboxIds = (found: Session) => ({
  orgId: found.runtime.spec.org_id,
  assignmentId: found.brief.snapshot.assignment_id,
})

/**
 * The agent's `checkpoint` is a commit on the container's disk, and the
 * platform can replace the container under a running turn (open item 56). So
 * each commit also goes to R2, where the next turn can find it. A save that
 * fails is logged and the turn goes on: the work is no worse off than before.
 */
async function save(found: Session) {
  try {
    found.tee.emit(
      "sandbox.checkpointed",
      await checkpoint(env, sandboxIds(found))
    )
  } catch (error) {
    found.tee.emit("sandbox.checkpoint_failed", {
      message: String(error).slice(0, 300),
    })
  }
}

/** Whether a turn after the first has a site to go on with, logged when it had to be found. */
async function siteKept(found: Session): Promise<boolean> {
  const back = await recover(env, sandboxIds(found))
  if (back.site !== "kept") found.tee.emit("sandbox.recovered", back)
  return back.site !== "gone"
}

/** The Workflow instance for an assignment, which the tools write to and nothing else reaches. */
const workflow = (assignmentId: string) => env.ASSIGNMENTS.get(assignmentId)

function session(id: string, brief: Brief, runtime: ResolvedRuntime): Session {
  const found = sessions.get(id)
  if (found) return found
  const kit = tenancy(env.HYPERDRIVE.connectionString)
  const tee = createTee({
    sink: eventSink(kit, runtime.spec.org_id),
    ids: {
      org_id: runtime.spec.org_id,
      staff_id: runtime.spec.staff_id,
      assignment_id: brief.snapshot.assignment_id,
      session_id: runtime.spec.session_id,
    },
    // Inside a Durable Object the alarm that runs the response awaits its
    // own work; the tee's chain is flushed at every would-stop point below.
    waitUntil: (promise) => {
      promise.catch(() => undefined)
    },
  })
  const created: Session = {
    tee,
    budget: undefined as unknown as BudgetGuard,
    runtime,
    kit,
    brief,
    gate: undefined as unknown as TurnGate,
    mutations: createMutationQueue(),
    interruptions: new Set(),
    budgetExhausted: false,
  }
  created.gate = createTurnGate({
    onInterrupt: (reason) => wake(created, `gate:${reason}`, reason),
    interruptNow: platformInterrupted,
    onToolDone: (name) => (name === "checkpoint" ? save(created) : undefined),
    // Which subagents the lead's interrupted turn cut short, so its resume
    // knows what to send again.
    onCancel: (taskId, reason) =>
      tee.emit("developer.task_cancelled", { task_id: taskId, reason }),
  })
  const budget = createBudgetGuard({
    capUsd: runtime.budget.model_usd_cap,
    spentUsd: runtime.budget.model_usd_spent,
    // The cap is per assignment, and this isolate is not the first to spend
    // against it after an eviction, a resume or a rehydrate.
    spentBefore: () =>
      kit.withOrg({ orgId: runtime.spec.org_id }, (db) =>
        assignmentCost(db, brief.snapshot.assignment_id)
      ),
    onEvent: (event) => {
      tee.emit(event.type, event.payload)
      if (event.type === "budget.exhausted") {
        created.budgetExhausted = true
        // §13: the Workflow parks the assignment; the refusal that follows
        // ends this response.
        tee
          .flush()
          .then(() => workflow(brief.snapshot.assignment_id))
          .then((instance) =>
            instance.sendEvent({
              type: "developer",
              payload: {
                kind: "budget",
                cap_usd: event.payload.cap_usd,
                spent_usd: event.payload.spent_usd,
              },
            })
          )
          .catch(() => undefined)
      }
    },
  })
  created.budget = budget
  sessions.set(id, created)
  return created
}

export function Developer({ id }: AgentProps) {
  const raw = useInitialData<Brief | undefined>()
  if (!raw) throw new Error("the Developer needs a brief at creation")
  // Verified before anything renders (§6.1): a forged, widened or expired
  // spec ends here with a typed refusal and the model is never called.
  const runtime = resolveRuntime(raw.spec, env.RUNTIME_SPEC_KEY)
  const brief: Brief = {
    ...raw,
    spec: RuntimeSpec.parse(raw.spec),
    snapshot: FactSnapshot.parse(raw.snapshot),
  }
  const current = session(id, brief, runtime)

  // The fallback model (open item 50): the Workflow's last resume after a
  // provider failure asks for it on the signal, and once on it the
  // conversation stays on it. Read at render, so the switch lands on the
  // very submission that asked.
  const delivery = useDelivery()
  const [onFallback, setOnFallback] = usePersistentState<boolean>(
    "use_fallback",
    false
  )
  const askedForFallback =
    delivery.kind === "signal" && delivery.attributes?.model === "fallback"
  // QE4: a section change starts on the quick section role (Sonnet, low) and
  // moves to the build role, for good, when the Workflow's resume or repair
  // signal asks for it: the quick lane's last step up.
  const [onBuildRole, setOnBuildRole] = usePersistentState<boolean>(
    "build_role",
    false
  )
  const askedForBuildRole =
    delivery.kind === "signal" && delivery.attributes?.role === "build"
  // The section lane's short prompt lasts as long as its role does.
  const sectionRole =
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the value is whatever the hook persisted, not its default
    brief.role && !(onBuildRole || askedForBuildRole) ? brief.role : null
  const route = sectionRole ? roleOf(runtime.spec, sectionRole) : runtime
  // The wire cap is the role's, found by these instructions (withOutputCap).
  const shown = () =>
    withOutputCap(
      (sectionRole ? sectionInstructions : instructions)(
        brief,
        runtime.budget.model_usd_cap
      ),
      sectionRole
        ? roleOf(runtime.spec, sectionRole).maxTokens
        : runtime.maxOutputTokens
    )
  const model =
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the value is whatever the hook persisted, not its default
    (onFallback || askedForFallback) && runtime.fallback
      ? runtime.fallback
      : route.model
  // pi-ai sends effort "none" when no level is given, so the role's effort
  // (build: medium, the Blueprint is the specification) is named here.
  useModel(model, { thinkingLevel: route.effort })
  // QE2: the site's sandbox, the one the Workflow provisioned and may have
  // found warm. One per site is safe because the site lock
  // (`assignments_site_writer_key`) lets one assignment at a time write it.
  const stub = getSandbox(env.SANDBOX as never, runtime.spec.org_id)
  const base = cloudflareSandbox(stub as never)
  useSandbox(
    {
      createSandbox: base.createSandbox,
      tools: guardedTools(POLICY, {
        git: GIT,
        mutations: current.mutations,
        fromChild: current.gate.fromChild,
      }),
    },
    { cwd: SITE_ROOT }
  )

  const [restored, setRestored] = usePersistentState<boolean>("restored", false)
  const [segmentLogged, setSegmentLogged] = usePersistentState<boolean>(
    "segment_logged",
    false
  )

  useAgentStart(async ({ harness }) => {
    // Every delivery is a new turn, so a turn a terminal tool ended reopens
    // here, and a failure that woke the Workflow before may wake it again.
    current.gate.open()
    current.interruptions.clear()
    if (askedForBuildRole && brief.role && !onBuildRole) {
      setOnBuildRole(true)
      current.tee.emit("model.switched", {
        from: roleOf(runtime.spec, brief.role).model,
        to: runtime.model,
        reason: "quick.fell_through",
      })
    }
    if (model !== route.model && !onFallback) {
      setOnFallback(true)
      current.tee.emit("model.switched", {
        from: route.model,
        to: model,
        reason:
          (delivery.kind === "signal" ? delivery.attributes?.reason : null) ??
          "provider.unavailable",
      })
    }
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the value is whatever the hook persisted, not its default
    if (!segmentLogged) {
      // §10.6: what the model was shown is in the log before it is shown.
      current.tee.emit("runtime.context_segment", {
        snapshot_id: brief.snapshot.snapshot_id,
        instructions: shown(),
      })
      setSegmentLogged(true)
    }
    // biome-ignore lint/suspicious/noUnnecessaryConditions: same, the persisted value
    if (restored && (await siteKept(current))) return
    const sandbox = harness.sandbox
    // The owner's photos and the plan's generated ones, which the
    // instructions list, copied in from the bucket.
    const photos = async (into: typeof sandbox) => {
      const missing = await placePhotos(
        into,
        env.SITES,
        runtime.spec.org_id,
        brief.snapshot.facts
      )
      if (missing.length > 0) {
        current.tee.emit("sandbox.photos_missing", { asset_ids: missing })
      }
      // BA4: the plan's generated photos the Workflow made, by slot.
      const files = brief.photos ?? []
      if (files.length === 0) return
      const placed = await placeGenerated(into, env.SITES, files)
      const lost = files.filter((f) => !placed[f.slot_id])
      if (lost.length > 0) {
        current.tee.emit("sandbox.photos_missing", {
          slot_ids: lost.map((f) => f.slot_id),
        })
      }
    }
    await sandbox.exec(`mkdir -p ${SITE_ROOT}`)
    if (brief.restore_key) {
      // QE2, one restore and not two: `brief.map` is set only when the
      // Workflow restored this revision or found it warm before admitting
      // us. A container replaced since has no `.git`, and restores here.
      const prepared =
        brief.map !== null &&
        (await sandbox.exec(`test -d ${SITE_ROOT}/.git`)).exitCode === 0
      if (!prepared) {
        const object = await env.SITES.get(brief.restore_key)
        if (!object) {
          throw new Error(`no source snapshot at ${brief.restore_key}`)
        }
        await sandbox.writeFile(
          "/tmp/source.tar.zst",
          new Uint8Array(await object.arrayBuffer())
        )
        const restore = await sandbox.exec(
          `tar --zstd -xf /tmp/source.tar.zst -C ${SITE_ROOT} && cd ${SITE_ROOT} && ln -sfn /opt/astro/node_modules node_modules`
        )
        if (restore.exitCode !== 0)
          throw new Error(`restore failed: ${restore.stderr}`)
      }
      // The owner's quote questions as the facts hold them now: a newer
      // `quote.form` replaces the restored file, the same one keeps it.
      await sandbox.writeFile(
        `${SITE_ROOT}/${QUOTE_FORM_FILE}`,
        quoteFormFile(brief.snapshot.facts)
      )
      await photos(sandbox)
    } else {
      for (const [relative, content] of Object.entries(
        seedFiles(brief.snapshot.facts)
      )) {
        await sandbox.writeFile(`${SITE_ROOT}/${relative}`, content)
      }
      // Before the first commit, so the photos are part of the starter.
      await photos(sandbox)
      const seeded = await sandbox.exec(
        `cd ${SITE_ROOT} && ln -sfn /opt/astro/node_modules node_modules && ${GIT} init -q && ${GIT} add -A && ${GIT} commit -qm "starter"`
      )
      if (seeded.exitCode !== 0)
        throw new Error(`seed failed: ${seeded.stderr}`)
    }
    // The photos as placed are the baseline the report holds the lead to.
    const sealed = await sandbox.exec(`cd ${SITE_ROOT} && ${SEAL_PHOTOS}`)
    if (sealed.exitCode !== 0)
      throw new Error(`photo seal failed: ${sealed.stderr}`)
    setRestored(true)
  })

  // BA4: registered on every run so the lead's tool list, and the prefix it
  // caches, is the same for every build; only a planned first build's
  // instructions call it.
  useTool(writePagesTool(current))
  useTool(askChief(current))
  useTool(reportComplete(current))

  useResponseFinish(({ response }) => {
    // A turn that wakes the Workflow ends in an accepted report or a
    // question, or woke it on the way (a failure, the budget). One that ends
    // any other way, the lead giving up after refused reports or running out
    // of turns, would leave the build waiting on a wake that never comes.
    const reported = response.toolCalls.some(
      (call) => !call.isError && WAKING_TOOLS.has(call.tool)
    )
    if (reported || current.budgetExhausted || current.interruptions.size > 0)
      current.tee.flush().catch(() => undefined)
    else wake(current, "unreported", "developer.no_report", "unreported")
  })

  return shown()
}

Developer.agentName = "developer"
Developer.durability = { maxAttempts: 3, timeoutMs: LEAD_TURN_MS }

/** How long `write_pages` waits for the photo step, from its start. */
const PHOTO_WAIT_MS = 5 * 60_000
const CONFIG = `${SITE_ROOT}/src/site-config.ts`

/**
 * BA4's fan-out, in code (write-pages.ts): every page writer and the copy
 * writer as one model call each, FAN_OUT at once, while the plan's photos
 * land in the site and warm Astro's image cache; then each photo's path
 * as it landed, the photo seal and one "pages" commit, saved like a
 * checkpoint. Durable: a replay after an interruption returns each writer's
 * recorded reply, and every write it makes is the same again.
 */
export const writePagesTool = (current: Session) =>
  defineTool({
    name: "write_pages",
    description:
      "Writes every page's site fields and the SEO and FAQ copy, one writer per page in parallel, places the plan's photos as they are made and commits. Call it once, alone, after the shell's checkpoint. Returns one line per writer.",
    input: toolInput(z.object({})),
    harness: true,
    durable: true,
    async run({ harness, step }) {
      const { brief } = current
      if (!fansOut(brief)) {
        return {
          output:
            "Nothing to do: write_pages is for a planned first build only.",
        }
      }
      const { spec } = current.runtime
      const orgId = spec.org_id
      const assignmentId = brief.snapshot.assignment_id
      const sandbox = harness.sandbox
      const stub = getSandbox(env.SANDBOX as never, orgId)
      const plan = brief.blueprint
      const tasks = writerTasks(plan, serviceCount(brief))
      const total = plan.pages.length
      const shown = new Set<string>()
      current.tee.emit("build.progress", { stage: "pages", item: null, total })

      // One change at a time, through the assignment's queue for this file.
      const edit = (change: (source: string) => string) =>
        current.mutations(CONFIG, async () => {
          const { content } = await stub.readFile(CONFIG)
          const next = change(content)
          if (next !== content) await stub.writeFile(CONFIG, next)
          return next
        })
      const roles = {
        page: roleOf(spec, "page"),
        copy: roleOf(spec, "copy"),
      }
      // One string per agent, so siblings share a cached prefix.
      const systems = {
        page: pageInstructions(brief),
        copy: copyInstructions(brief),
      }
      const call = (
        index: number,
        attempt: 1 | 2,
        user: string,
        strict: boolean
      ) =>
        step.do(`writer ${index + 1}.${attempt}`, async () => {
          const task = tasks[index] as (typeof tasks)[number]
          const route = roles[task.agent]
          const reply = await completeOnce(env, {
            model: route.model,
            effort: route.effort,
            maxTokens: route.maxTokens,
            system: systems[task.agent],
            user,
            sessionId: assignmentId,
            // Strict only to retry an unparsable reply (write-pages.ts).
            ...(strict
              ? { schema: replySchema(fieldsOfPrompt(task.prompt)) }
              : {}),
          })
          await logTurn(
            current.kit,
            { orgId, assignmentId },
            spec.staff_id,
            task.agent,
            reply
          )
          return reply.text
        })

      // The photo step's progress rows carry each slot's key as it lands;
      // its `site.photos` event is the final list, and a `site.photos_failed`
      // from the Workflow settles it with what landed.
      const slots = plan.images
        .filter((s) => s.source === "generated" && !s.asset_id)
        .map((s) => s.id)
      const landed = (): Promise<Landed> =>
        current.kit.withOrg({ orgId }, async (db) =>
          landedOf(
            await db
              .select({ type: events.type, payload: events.payload })
              .from(events)
              .where(
                sql`${events.assignmentId} = ${assignmentId} and (${events.type} in ('site.photos', 'site.photos_failed') or (${events.type} = 'build.progress' and ${events.payload}->>'stage' = 'photos' and ${events.payload}->>'key' is not null))`
              )
              .orderBy(events.eventId)
          )
        )
      const warm = createWarmer(() => sandbox.exec(WARM_BUILD))
      const following = followPhotos({
        slots,
        landed,
        place: (files) => placeGenerated(sandbox, env.SITES, files),
        onPlaced: warm.kick,
        pollMs: 2000,
        timeoutMs: PHOTO_WAIT_MS,
      })
      const lines = await writePages({
        tasks,
        max: FAN_OUT,
        staggerMs: 3000,
        call,
        edit,
        onWritten: (task) => {
          warm.kick()
          const page = pageOfPrompt(task.prompt)
          if (!page || shown.has(page)) return
          shown.add(page)
          current.tee.emit("build.progress", {
            stage: "pages",
            item: page,
            total,
          })
        },
      })
      const photos = await following
      const before = await edit((s) => s)
      if (
        (await edit((s) => reconcilePhotos(s, slots, photos.files))) !== before
      )
        warm.kick()
      // The photos as placed are the baseline the report holds the lead to.
      await sandbox.exec(`cd ${SITE_ROOT} && ${SEAL_PHOTOS}`)
      await warm.idle()
      await sandbox.exec(
        `cd ${SITE_ROOT} && ${GIT} add -A && ${GIT} commit -qm pages || true`
      )
      await save(current)
      const missing = slots.filter(
        (id) => !photos.files.some((f) => f.slot_id === id)
      )
      return {
        output: [
          `Wrote ${tasks.length} writers' fields and committed them as "pages":`,
          ...lines,
          ...(missing.length > 0
            ? [
                `No photo for ${missing.join(", ")} (${photos.timedOut ? "the photo step did not finish in time" : "it fell back"}): its field is empty, so its section takes the no-image form.`,
              ]
            : []),
          "The photos are placed and the image cache is warm. Integrate now.",
        ].join("\n"),
      }
    },
  })

/**
 * The only escalation (§7.2): name the fact, why, and the shape an answer
 * must take. Writes the request to the log, wakes the Workflow with its id,
 * and ends the turn; the answer arrives as the next message.
 */
export const askChief = (current: Session) =>
  defineTool({
    name: "ask_chief",
    description: ASK_CHIEF_DESCRIPTION,
    input: toolInput(AskChiefInput),
    async run({ data }) {
      // Thrown, so the model reads why and asks again (open item 70).
      const refusal = refuseQuestion(data)
      if (refusal) throw new Error(refusal)
      const { spec } = current.runtime
      const request = InformationRequest.parse({
        request_id: crypto.randomUUID(),
        org_id: spec.org_id,
        assignment_id: current.brief.snapshot.assignment_id,
        requested_by_staff_id: spec.staff_id,
        field: data.field,
        why: data.why,
        answer_schema: data.answer_schema,
        options: askedOptions(data),
        blocking: data.blocking,
        requested_at: new Date().toISOString(),
        expires_at: null,
      })
      current.tee.emit("information.requested", request)
      // Append first, wake second (architect ruling 8): a Workflow woken
      // before the row exists reads nothing.
      await current.tee.flush()
      await (await workflow(request.assignment_id)).sendEvent({
        type: "developer",
        payload: { kind: "information", request_id: request.request_id },
      })
      return {
        output: `Asked for ${data.field}. Stop here; the answer arrives as your next message.`,
        terminate: true,
      }
    },
  })

/**
 * The end of a build (§8.2 "Verify before claiming done"): the tool itself
 * runs the checks, uploads the artifact and the source snapshot as durable
 * steps (the screenshots follow the preview, in the Workflow), writes the revision row, logs the
 * `CompletionReport` and wakes the Workflow. A report with nothing checked
 * cannot exist, because this is the only way to make one.
 *
 * Only while the assignment is `implementing`: a lead resumed after an
 * interruption can call it again for a report the Workflow already took,
 * and that run would rebuild the disk under the preview's own steps.
 */
export const reportComplete = (current: Session) =>
  defineTool({
    name: "report_complete",
    description:
      "Report the build done. Runs astro check and astro build, uploads the site, and ends your turn. Call it only when every claim on the site traces to a fact and the site builds.",
    input: toolInput(
      CompletionReport.pick({
        summary: true,
        changes: true,
        risks: true,
        decisions_needed: true,
      })
    ),
    harness: true,
    durable: true,
    async run({ data, harness, step }) {
      const { spec } = current.runtime
      const orgId = spec.org_id
      const assignmentId = current.brief.snapshot.assignment_id
      const [row] = await current.kit.withOrg({ orgId }, (db) =>
        db
          .select({ state: assignments.state })
          .from(assignments)
          .where(eq(assignments.id, assignmentId))
      )
      if (row?.state !== "implementing") {
        return {
          output: `Nothing to report: the build is ${row?.state ?? "gone"}, not implementing. Your turn is over.`,
          terminate: true,
        }
      }
      const sandbox = harness.sandbox
      const toolStarted = Date.now()
      const { revisionId, check, build, manifest, custom, source } =
        await finishRevision({
          steps: step,
          sandbox,
          kit: current.kit,
          sites: env.SITES,
          hostSuffix: env.SITE_HOST_SUFFIX,
          orgId,
          assignmentId,
          facts: current.brief.snapshot.facts,
          holdPhotos: true,
        })

      const report = CompletionReport.parse({
        report_id: crypto.randomUUID(),
        org_id: orgId,
        assignment_id: assignmentId,
        session_id: spec.session_id,
        revision_id: revisionId,
        summary: data.summary,
        changes: data.changes,
        // Taken after the preview is ready, by the Workflow; the router serves
        // them by name from this revision's prefix.
        screenshots: [],
        checks: checksOf({ check, build, custom }),
        risks: data.risks,
        decisions_needed: data.decisions_needed,
        reported_at: new Date().toISOString(),
      })
      // Model output: nothing downstream may promote it (§28.3).
      current.tee.emit("assignment.completion_reported", report, ["inferred"])
      await current.tee.flush()
      const turns = await current.kit
        .withOrg({ orgId }, (db) => turnCount(db, assignmentId))
        .catch(() => null)
      await (await workflow(assignmentId)).sendEvent({
        type: "developer",
        payload: {
          kind: "completion",
          report_id: report.report_id,
          revision_id: revisionId,
          timings: {
            check_ms: check.ms,
            build_ms: build.ms,
            upload_ms: manifest.ms,
            upload_files: manifest.files,
            upload_reused: manifest.reused,
            upload_bytes: manifest.bytes,
            source_ms: source.ms,
            // Replayed steps return their first run's ms, so the tool's own
            // wall time is the one that says what the whole call cost.
            tool_ms: since(toolStarted),
            model_turns: turns,
            reported_at: Date.now(),
          },
        },
      })
      return {
        output: `Reported revision ${revisionId} with ${manifest.files} files. Your turn is over.`,
        terminate: true,
      }
    },
  })
