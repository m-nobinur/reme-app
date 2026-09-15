"use agent"
import { env } from "cloudflare:workers"
import { getSandbox } from "@cloudflare/sandbox"
import {
  CompletionReport,
  DeploymentManifest,
  FactSnapshot,
  InformationRequest,
  RuntimeSpec,
} from "@workspace/contracts"
import { siteRevisions, sql, type Tenancy, tenancy } from "@workspace/db"
import {
  type AgentProps,
  type BudgetGuard,
  createBudgetGuard,
  createTee,
  createTurnGate,
  defineTool,
  guardedTools,
  instrument,
  observe,
  type ResolvedRuntime,
  registerProviders,
  resolveRuntime,
  type Tee,
  type TurnGate,
  toolInput,
  useAgentStart,
  useInitialData,
  useModel,
  usePersistentState,
  useResponseFinish,
  useSandbox,
  useTool,
} from "@workspace/facade"
import { cloudflareSandbox } from "@workspace/facade/cloudflare"
import type { Brief } from "../brief.ts"
import { repoMap } from "../repo-map.ts"
import { eventSink } from "../sink.ts"

/**
 * The Developer (§8, ADR-031): one Durable Object conversation per
 * assignment, a container that is a filesystem and a shell, tools that write
 * to the Workflow and never to the container's network. The spec is verified
 * before any hook renders; every runtime event is teed into the log; the
 * budget guard sits in front of every model call.
 */

/** Where the site lives in the container. `/opt/astro` is the toolchain, read-only. */
export const SITE_ROOT = "/workspace/site"
const POLICY = { siteRoot: SITE_ROOT, readOnlyRoots: ["/opt/astro"] }
const GIT = "git -c user.name=reme -c user.email=developer@reme.invalid"

/**
 * The starter site, bundled into the Worker as text so the fixture in the
 * repo is the one source (N5 swaps this for `packages/starter-site`). The
 * model never sees this path; it sees the files in the sandbox.
 */
// The glob skips dotfiles unless named, and the starter has one.
const STARTER = import.meta.glob(
  [
    "../../../../fixtures/sites/starter/**/*",
    "../../../../fixtures/sites/starter/.gitignore",
  ],
  {
    query: "?raw",
    import: "default",
    eager: true,
  }
) as Record<string, string>

/** The starter's files by their path in the site. */
const STARTER_FILES = Object.fromEntries(
  Object.entries(STARTER).map(([file, content]) => [
    file.slice(file.indexOf("/starter/") + "/starter/".length),
    content,
  ])
)

/**
 * The map in the stable segment, built once from the bundled starter so it
 * cannot drift from the files the sandbox is seeded with. A restored site
 * (`site.revise`) needs its map built from the container at agent start and
 * logged before the model sees it; that lands with the revise story.
 */
const STARTER_MAP = repoMap(STARTER_FILES)

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
}
const sessions = new Map<string, Session>()

// One tee and one budget guard per conversation, found by the instance id
// every event and interception carries. Registered once per isolate.
observe((observation, ctx) => {
  const found = sessions.get(ctx.id)
  if (!found) return
  found.tee.subscriber(observation)
  found.budget.instrumentation.observe(observation, ctx)
})
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
  const budget = createBudgetGuard({
    capUsd: runtime.budget.model_usd_cap,
    spentUsd: runtime.budget.model_usd_spent,
    onEvent: (event) => {
      tee.emit(event.type, event.payload)
      if (event.type === "budget.exhausted") {
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
  const created = { tee, budget, runtime, kit, brief, gate: createTurnGate() }
  sessions.set(id, created)
  return created
}

/** The stable prompt segment: role, rules, the fact snapshot, the starter's shape. Volatile things stay out of it so the provider's cache holds. */
function instructions(brief: Brief, runtime: ResolvedRuntime): string {
  const facts = brief.snapshot.facts
    .map((f) => `- ${f.key} (${f.fact_type}): ${JSON.stringify(f.value)}`)
    .join("\n")
  return [
    "You are the Developer at Reme, building a small business's website in the Astro site under /workspace/site. You build from canonical facts and from nothing else.",
    "",
    "Rules:",
    '- Every price, phone number, email, opening hour, service area, review or certification on the site must come from the facts below. The site needs business.name, business.phone, business.email, hours.weekday, service_area.radius and pricing.standard_clean_hourly. If any of those is not listed below, call ask_chief for the first missing one before you edit anything, and stop; never invent a value and never write a placeholder such as "TBD", "555", "lorem" or an example domain.',
    "- Edit a file with one edit call carrying every replacement for that file in edits[]; each oldText must match one region of the file exactly. Use write only for a new file. Never rewrite a file to change one line.",
    "- src/site-config.ts is where every string on the site comes from; fill its fields from the facts. An empty field renders nothing. Only tagline may stay empty; every other field needs a fact.",
    "- Read every file you need in one turn; reads run together.",
    "- node_modules is a read-only link to the image's toolchain; never run pnpm install, npm install or anything that reaches the network.",
    "- Run ./node_modules/.bin/astro check and ./node_modules/.bin/astro build with bash before you report. Fix what they report.",
    "- Call checkpoint after a coherent set of edits.",
    "- A validation.failed message lists the gates your reported build failed, each with its message and the node it names. Fix exactly those, check and build again, and call report_complete again.",
    "- End your turn with exactly one of: ask_chief (a fact is missing) or report_complete (the site builds and every claim traces to a fact). Do not end a turn any other way.",
    "",
    `Assignment goal: ${brief.goal}`,
    "Acceptance criteria:",
    ...brief.acceptance_criteria.map((c) => `- ${c}`),
    "",
    `Canonical facts (snapshot ${brief.snapshot.snapshot_id}):`,
    facts || "- (none)",
    "",
    "Site map (every file, in path order):",
    STARTER_MAP,
    "",
    `Budget: ${runtime.budget.model_usd_cap} USD of model spend for this assignment. Be brief.`,
  ].join("\n")
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

  useModel(runtime.model, { thinkingLevel: "low" })
  const stub = getSandbox(env.SANDBOX as never, id)
  const base = cloudflareSandbox(stub as never)
  useSandbox(
    {
      createSandbox: base.createSandbox,
      tools: guardedTools(POLICY, { git: GIT }),
    },
    { cwd: SITE_ROOT }
  )

  const [restored, setRestored] = usePersistentState<boolean>("restored", false)
  const [segmentLogged, setSegmentLogged] = usePersistentState<boolean>(
    "segment_logged",
    false
  )

  useAgentStart(async ({ harness }) => {
    // Every delivery is a new turn, so a turn a terminal tool ended reopens here.
    current.gate.open()
    // biome-ignore lint/suspicious/noUnnecessaryConditions: the value is whatever the hook persisted, not its default
    if (!segmentLogged) {
      // §10.6: what the model was shown is in the log before it is shown.
      current.tee.emit("runtime.context_segment", {
        snapshot_id: brief.snapshot.snapshot_id,
        instructions: instructions(brief, runtime),
      })
      setSegmentLogged(true)
    }
    // biome-ignore lint/suspicious/noUnnecessaryConditions: same, the persisted value
    if (restored) return
    const sandbox = harness.sandbox
    await sandbox.exec(`mkdir -p ${SITE_ROOT}`)
    if (brief.restore_key) {
      const object = await env.SITES.get(brief.restore_key)
      if (!object) throw new Error(`no source snapshot at ${brief.restore_key}`)
      await sandbox.writeFile(
        "/tmp/source.tar.zst",
        new Uint8Array(await object.arrayBuffer())
      )
      const restore = await sandbox.exec(
        `tar --zstd -xf /tmp/source.tar.zst -C ${SITE_ROOT}`
      )
      if (restore.exitCode !== 0)
        throw new Error(`restore failed: ${restore.stderr}`)
    } else {
      for (const [relative, content] of Object.entries(STARTER_FILES)) {
        await sandbox.writeFile(`${SITE_ROOT}/${relative}`, content)
      }
      const seeded = await sandbox.exec(
        `cd ${SITE_ROOT} && ln -sfn /opt/astro/node_modules node_modules && ${GIT} init -q && ${GIT} add -A && ${GIT} commit -qm "starter"`
      )
      if (seeded.exitCode !== 0)
        throw new Error(`seed failed: ${seeded.stderr}`)
    }
    setRestored(true)
  })

  useTool(askChief(current))
  useTool(reportComplete(current))

  useResponseFinish(() => {
    current.tee.flush().catch(() => undefined)
  })

  return instructions(brief, runtime)
}

Developer.agentName = "developer"
Developer.durability = { maxAttempts: 3, timeoutMs: 45 * 60 * 1000 }

/**
 * The only escalation (§7.2): name the fact, why, and the shape an answer
 * must take. Writes the request to the log, wakes the Workflow with its id,
 * and ends the turn; the answer arrives as the next message.
 */
const askChief = (current: Session) =>
  defineTool({
    name: "ask_chief",
    description:
      "Ask the Chief of Staff for one canonical fact the site needs and does not have. Name the fact key (for example business.phone), why the site needs it, and the JSON Schema an answer must satisfy. This ends your turn; the answer comes back as a new message.",
    input: toolInput(
      InformationRequest.pick({
        field: true,
        why: true,
        answer_schema: true,
        options: true,
        blocking: true,
      })
    ),
    async run({ data }) {
      const { spec } = current.runtime
      const request = InformationRequest.parse({
        request_id: crypto.randomUUID(),
        org_id: spec.org_id,
        assignment_id: current.brief.snapshot.assignment_id,
        requested_by_staff_id: spec.staff_id,
        field: data.field,
        why: data.why,
        answer_schema: data.answer_schema,
        options: data.options ?? null,
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

const VIEWPORTS = [390, 768, 1440] as const

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
}

const sha256 = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0")
  ).join("")

/**
 * The end of a build (§8.2 "Verify before claiming done"): the tool itself
 * runs the checks, takes the screenshots, uploads the artifact and the
 * source snapshot as durable steps, writes the revision row, logs the
 * `CompletionReport` and wakes the Workflow. A report with nothing checked
 * cannot exist, because this is the only way to make one.
 */
const reportComplete = (current: Session) =>
  defineTool({
    name: "report_complete",
    description:
      "Report the build done. Runs astro check and astro build, takes screenshots, uploads the site, and ends your turn. Call it only when every claim on the site traces to a fact and the site builds.",
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
      const sandbox = harness.sandbox
      const run = (command: string) =>
        sandbox.exec(`cd ${SITE_ROOT} && ${command}`, { timeoutMs: 180_000 })

      const check = await step.do("astro check", async () => {
        const r = await run("./node_modules/.bin/astro check 2>&1 | tail -20")
        return { exit_code: r.exitCode, output: r.stdout.slice(-2000) }
      })
      const build = await step.do("astro build", async () => {
        const r = await run("./node_modules/.bin/astro build 2>&1 | tail -20")
        return { exit_code: r.exitCode, output: r.stdout.slice(-2000) }
      })
      if (build.exit_code !== 0) {
        throw new Error(
          `astro build failed, fix it before reporting:\n${build.output}`
        )
      }

      const revisionId = await step.do("revision", async () =>
        current.kit.withOrg({ orgId }, async (db) => {
          const [latest] = await db
            .select({
              max: sql<number>`coalesce(max(${siteRevisions.version}), 0)::int`,
            })
            .from(siteRevisions)
            .where(sql`${siteRevisions.siteId} = ${orgId}`)
          const id = crypto.randomUUID()
          const prefix = `sites/${orgId}/${id}/`
          await db.insert(siteRevisions).values({
            id,
            orgId,
            siteId: orgId,
            assignmentId,
            version: (latest?.max ?? 0) + 1,
            sourceKey: `${prefix}source.tar.zst`,
            artifactPrefix: `${prefix}dist/`,
            manifestKey: `${prefix}manifest.json`,
          })
          return id
        })
      )
      const prefix = `sites/${orgId}/${revisionId}/`

      const screenshots = await step.do("screenshots", async () => {
        const script = [
          "(./node_modules/.bin/astro preview --host 127.0.0.1 --port 4321 > /tmp/preview.log 2>&1 &)",
          "for i in $(seq 1 20); do curl -sf -o /dev/null http://127.0.0.1:4321/ && break; sleep 1; done",
          ...VIEWPORTS.map(
            (w) =>
              `playwright screenshot --browser chromium --viewport-size=${w},900 --full-page http://127.0.0.1:4321/ /tmp/home-${w}.png`
          ),
          "pkill -f 'astro preview' || true",
        ].join(" && ")
        const r = await run(script)
        const keys: string[] = []
        for (const w of VIEWPORTS) {
          const path = `/tmp/home-${w}.png`
          if (!(await sandbox.exists(path))) continue
          const key = `${prefix}screenshots/home-${w}.png`
          await env.SITES.put(key, await sandbox.readFileBuffer(path))
          keys.push(key)
        }
        return { keys, exit_code: r.exitCode, output: r.stdout.slice(-500) }
      })

      const manifest = await step.do("upload dist", async () => {
        const listing = await run("find dist -type f | sort")
        const files: Record<string, string> = {}
        const routes: { path: string; file: string }[] = []
        for (const line of listing.stdout.split("\n").filter(Boolean)) {
          const file = line.replace(/^dist\//, "")
          const bytes = await sandbox.readFileBuffer(`${SITE_ROOT}/${line}`)
          files[file] = await sha256(bytes)
          await env.SITES.put(`${prefix}dist/${file}`, bytes)
          if (file.endsWith("index.html")) {
            routes.push({ path: `/${file.replace(/index\.html$/, "")}`, file })
          }
        }
        const parsed = DeploymentManifest.parse({
          revision_id: revisionId,
          site_id: orgId,
          org_id: orgId,
          routes,
          headers: SECURITY_HEADERS,
          files,
          built_at: new Date().toISOString(),
        })
        await env.SITES.put(`${prefix}manifest.json`, JSON.stringify(parsed))
        return { files: Object.keys(files).length }
      })

      await step.do("upload source", async () => {
        const r = await run(
          `${GIT} add -A && (${GIT} commit -qm "report_complete" || true) && tar --zstd -cf /tmp/source.tar.zst --exclude=./node_modules --exclude=./dist --exclude=./.vite -C ${SITE_ROOT} .`
        )
        if (r.exitCode !== 0)
          throw new Error(`source snapshot failed: ${r.stderr}`)
        await env.SITES.put(
          `${prefix}source.tar.zst`,
          await sandbox.readFileBuffer("/tmp/source.tar.zst")
        )
        return { key: `${prefix}source.tar.zst` }
      })

      const report = CompletionReport.parse({
        report_id: crypto.randomUUID(),
        org_id: orgId,
        assignment_id: assignmentId,
        session_id: spec.session_id,
        revision_id: revisionId,
        summary: data.summary,
        changes: data.changes,
        screenshots: screenshots.keys,
        checks: [
          {
            check: "astro check",
            exit_code: check.exit_code,
            output_key: null,
          },
          {
            check: "astro build",
            exit_code: build.exit_code,
            output_key: null,
          },
        ],
        risks: [
          ...data.risks,
          ...(screenshots.keys.length < VIEWPORTS.length
            ? [
                `only ${screenshots.keys.length} of ${VIEWPORTS.length} screenshots were taken`,
              ]
            : []),
        ],
        decisions_needed: data.decisions_needed,
        reported_at: new Date().toISOString(),
      })
      // Model output: nothing downstream may promote it (§28.3).
      current.tee.emit("assignment.completion_reported", report, ["inferred"])
      await current.tee.flush()
      await (await workflow(assignmentId)).sendEvent({
        type: "developer",
        payload: {
          kind: "completion",
          report_id: report.report_id,
          revision_id: revisionId,
        },
      })
      return {
        output: `Reported revision ${revisionId} with ${manifest.files} files. Your turn is over.`,
        terminate: true,
      }
    },
  })
