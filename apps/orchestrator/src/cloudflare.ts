import {
  WorkerEntrypoint,
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers"
import { NonRetryableError } from "cloudflare:workflows"
import {
  Blueprint,
  type BuildLane,
  buildFailure,
  type ChangeKind,
  siteUrl,
} from "@workspace/contracts"
import {
  appendEvent,
  assignments,
  eq,
  facts,
  failureCode,
  listOrgIds,
  type Posted,
  type Tenancy,
  tenancy,
  toFactRecord,
  waitedOn,
} from "@workspace/db"
import {
  AgentInstanceExistsError,
  init,
  REPEATING_FAILURE,
  SANDBOX_UPDATING,
} from "@workspace/facade"
import { probeProof } from "@workspace/gates/preview"
import { Hono } from "hono"
import { Developer } from "./agents/developer.ts"
import { type ConsoleEnv, noRoute, ownerRoutes } from "./app.ts"
import {
  type Brief,
  creationChoices,
  failureReason,
  issueSpec,
  retryContext,
  takeSnapshot,
} from "./brief.ts"
import { critiqueRound, type Fix, repairMessage } from "./critic.ts"
import {
  DELIVERIES_QUEUES,
  type DeliveryMessage,
  deliveriesBatch,
  redriveDeliveries,
} from "./deliveries.ts"
import { postStatus, type Say, sweepDomains } from "./domain-flow.ts"
import { SAY_RETRIES } from "./domain-workflow.ts"
import { JOBS_QUEUES, jobsBatch } from "./jobs.ts"
import { makePhotos } from "./photo-step.ts"
import { planRound } from "./planner.ts"
import {
  accessible,
  activate,
  LIVE_SAY,
  latestRevision,
  PROBE_MINUTES,
  type PublishParams,
  probeHost,
  readTarget,
  redriveQueued,
  requestReview,
  sayLive,
  servedVerification,
  stillLive,
  verifyArtifact,
  writePointer,
} from "./publish.ts"
import { quickEdit } from "./quick.ts"
import { askOwner, heldSteers, relayQuestion } from "./relay.ts"
import { retireOthers, type SweepCounts, sweepOrg } from "./retention.ts"
import {
  afterFailure,
  noteProblem,
  noteResumed,
  postNote,
  readyNote,
  sayReady,
} from "./retry.ts"
import {
  latestBlueprint,
  mapSite,
  restoreAndMap,
  reviseSource,
  SITE_ROOT,
} from "./revise.ts"
import {
  checkpoint,
  checkpointKey,
  endSandbox,
  keepWarm,
  PoolExhaustedError,
  provision,
  rehydrate,
  sandboxFor,
  tailSandbox,
  takeScreenshots,
  takeWarm,
  takeWork,
  whileHeld,
  workKey,
} from "./sandbox.ts"
import { type JobsQueueMessage, SCHEDULE_CRON, scanDue } from "./schedule.ts"
import { afterPublish, startDueSyncs } from "./search-sync.ts"
import {
  advance,
  claim,
  lastEventAt,
  parkForBudget,
  TransitionError,
} from "./state.ts"
import { GIT, runAxe } from "./tail.ts"
import { logTiming, STALL_QUIET_MS, since, type ToolTimings } from "./timing.ts"
import { checkUptime, UPTIME_CRON } from "./uptime.ts"
import { assignmentFacts, checkA11y, validateRevision } from "./validate.ts"

export { RemeSandbox, SandboxEgress, SandboxPool } from "./container.ts"
export { DomainWorkflow } from "./domain-workflow.ts"
export { SearchSyncWorkflow, SearchWorkflow } from "./search-workflow.ts"

/** The owner's route tree: the bridge routes alone, behind `ownerAuth`. */
const ownerApp = new Hono<ConsoleEnv>({ strict: false })
  .route("/assignments", ownerRoutes())
  .notFound(noRoute)

/**
 * The owner's way in (ADR-032 amendment): a named entrypoint that only a
 * service binding naming it can reach. `apps/api` binds it; no route, custom
 * domain or version URL can, so the headers `ownerAuth` reads arrive from
 * `apps/api` and nowhere else (staging spike, 2026-09-26).
 */
export class OwnerApi extends WorkerEntrypoint<Env> {
  override fetch(request: Request) {
    return ownerApp.fetch(request, this.env, this.ctx)
  }
}

/** R8: ids only. Everything else is read from the row inside a step. */
export type AssignmentParams = { assignment_id: string; org_id: string }

/** What the Developer's tools send the Workflow: a kind and ids, never a body (R8). */
type DeveloperEvent =
  | { kind: "information"; request_id: string }
  | {
      kind: "completion"
      report_id: string
      revision_id: string
      timings?: ToolTimings
    }
  | { kind: "budget"; cap_usd: number; spent_usd: number }
  /** `key` names the failure, so a second wake for it resumes nothing. */
  | { kind: "interrupted"; reason: string; key?: string }
  | { kind: "unreported"; reason: string }
  | { kind: "start_failed"; reason: string }

/**
 * How long a round waits for its answer, from the block, and how long one
 * wait lasts before the round looks again. The looks, not the `answer`
 * events, find the answer: an event is only a nudge to look now, and the
 * timeout recovers a nudge that never arrived. With no nudges a round takes
 * 28 six-hour waits and 29 looks, one more if a timer fires early, and each
 * nudge adds a look and a wait: about 60 steps a round, 1,200 over the 20
 * rounds, inside the 10,000 steps an instance gets on Workers Paid (Workers
 * Free allows 1,024).
 */
const ANSWER_DEADLINE_MS = 7 * 24 * 60 * 60 * 1000
const LOOK_EVERY_MS = 6 * 60 * 60 * 1000
/** How soon a question the chat could not take yet is posted again. */
const POST_AGAIN_MS = 2 * 60 * 1000
/** Posts the chat will take later: the question is posted again. */
const QUEUED: ReadonlySet<Posted> = new Set(["busy", "waiting"])

/** How long a queued assignment waits for the site lock: 20 × 30 s. */
const CLAIM_ATTEMPTS = 20

/** How many times an interrupted Developer run is resumed before the build fails and releases the site lock. */
const RESUMES = 2

/**
 * A tenancy kit for one unit of work, closed when the work finishes. A
 * `TransitionError` that is not transient means the row moved under us, so
 * retrying cannot help: it leaves as `NonRetryableError` and the step is final.
 */
const withKit = async <T>(
  env: Env,
  fn: (kit: Tenancy) => Promise<T>
): Promise<T> => {
  const kit = tenancy(env.HYPERDRIVE.connectionString)
  try {
    return await fn(kit)
  } catch (error) {
    if (error instanceof TransitionError && error.errorClass !== "transient") {
      throw new NonRetryableError(error.code)
    }
    throw error
  } finally {
    await kit.close()
  }
}

/** The watchdog's reason for a Developer that went quiet (`STALL_QUIET_MS`). */
const DEVELOPER_STALLED = "developer.stalled"

/** Reasons the turn gate or the watchdog names itself; any other interruption is the provider's. */
const GATE_REASONS = new Set([
  REPEATING_FAILURE,
  SANDBOX_UPDATING,
  DEVELOPER_STALLED,
])

/** Information round trips per assignment before the Workflow stops waiting. */
const ROUNDS = 20

/**
 * One instance per assignment, one `step.do` per §8.4 state. A step that
 * throws a `transient` refusal is retried by Workflows; a `validation` or
 * `resource` one is final, because the row moved under us (cancelled from the
 * console) and no retry makes the edge legal.
 */
export class AssignmentWorkflow extends WorkflowEntrypoint<
  Env,
  AssignmentParams
> {
  async run(event: WorkflowEvent<AssignmentParams>, step: WorkflowStep) {
    const ids = {
      orgId: event.payload.org_id,
      assignmentId: event.payload.assignment_id,
    }
    const run = <T>(fn: (kit: Tenancy) => Promise<T>) => withKit(this.env, fn)

    // The instance's creation time is durable; a clock read between steps
    // would restart on every replay.
    const t0 = event.timestamp.getTime()
    let claimed = false
    let claimedAt = t0
    let superseded: string | null = null
    for (let attempt = 1; attempt <= CLAIM_ATTEMPTS && !claimed; attempt++) {
      const result = await step.do(`claim ${attempt}`, async () => ({
        ...(await run((kit) => claim(kit, ids, attempt === 1))),
        at: Date.now(),
      }))
      claimed = result.claimed
      claimedAt = result.at
      superseded = result.superseded
      // A superseded preview's container is the site's warm one, which this
      // assignment takes over below, so it is not destroyed here.
      if (!claimed) await step.sleep(`site busy ${attempt}`, "30 seconds")
    }
    if (!claimed) return { outcome: "queued" }

    // An owner's build that failed on our side starts once more, and the chat
    // hears what happened (retry.ts). Nothing here changes how this build ended.
    const followUp = async (kept: boolean) => {
      try {
        const { note, retry_id } = await step.do("retry", () =>
          run((kit) => afterFailure(this.env, kit, ids))
        )
        if (kept && !retry_id) {
          await step.do("drop work", () => this.env.SITES.delete(workKey(ids)))
        }
        if (note) {
          await step.do("say failed", SAY_RETRIES, () =>
            run((kit) => postNote(kit, ids.orgId, note))
          )
        }
      } catch {
        // The failure stands, and the panel shows it.
      }
    }
    // A retry of failed checks carries on from the site, so it is kept before
    // the sandbox goes; without it the retry starts afresh.
    const keepWork = async (reason: string) => {
      if (buildFailure(reason).retry !== "fix_forward") return false
      await step
        .do("keep work", async () => {
          const kept = await whileHeld(this.env, ids, () =>
            checkpoint(this.env, ids, workKey(ids))
          )
          return { taken: kept?.taken ?? false }
        })
        .catch(() => null)
      return true
    }
    // A build that cannot continue ends in `failed` and destroys its sandbox,
    // if it holds one (`endSandbox` leaves a warm one another build holds),
    // which releases the site lock (§13): a provider that keeps failing, a
    // Developer that never reports or a plan nobody decides on must not hold
    // the site for good.
    const fail = async (name: string, reason: string) => {
      await step.do(`fail ${name}`, () =>
        run((kit) => advance(kit, ids, "failed", { reason }))
      )
      const kept = await keepWork(reason)
      await step.do("destroy sandbox", async () => {
        await endSandbox(this.env, ids)
        return { destroyed: ids.assignmentId }
      })
      await followUp(kept)
      return { outcome: "failed" as const }
    }

    // The lane rides the planning step's return rather than a step of its
    // own, so a full build keeps its step list. An instance replayed from
    // before lanes existed gets the old return, with no lane: full.
    // `plan` rides it the same way: an instance from before planning gets
    // none and builds as it did.
    const route: {
      lane?: BuildLane
      change_kind?: ChangeKind | null
      plan?: boolean
    } = await step.do("planning", () =>
      run(async (kit) => {
        await advance(kit, ids, "planning")
        const { lane, change_kind, kind } = await kit.withOrg(
          { orgId: ids.orgId },
          (db) => creationChoices(db, ids)
        )
        // ADR-038: a first build plans, and so does a creative change; the
        // quick lane never does. The plan is approved as it is made: the
        // owner is never asked to review one, and an instance that was
        // waiting on a decision before this goes straight on to the build.
        const plan =
          lane === "full" &&
          (kind === "site.build" || change_kind === "creative")
        return { lane, change_kind, plan }
      })
    )
    if (route.plan) {
      await step.do("plan 1", () =>
        run((kit) => planRound({ env: this.env, kit, ids }))
      )
    }
    // The container, after the site lock and the owner's plan decision and
    // not before: the lock is one org's, the pool is everyone's, so the
    // scarce thing is taken last, and an owner who has not decided on a
    // Blueprint for days holds no slot (ADR-038). The
    // same loop as the claim, with one `pool.exhausted` event on the first
    // refusal only. Only a full pool waits; any other error takes the step's
    // retry policy, so a bad image fails rather than retrying for ten minutes.
    let ready = false
    let coldStartMs = 0
    let readyAt = claimedAt
    let askedAt = claimedAt
    for (let attempt = 1; attempt <= CLAIM_ATTEMPTS && !ready; attempt++) {
      const got = await step.do(`sandbox ${attempt}`, async () => {
        const started = Date.now()
        try {
          const { cold_start_ms, evicted } = await provision(this.env, ids)
          await run((kit) =>
            appendAudit(kit, ids, "sandbox.provisioned", {
              cold_start_ms,
              evicted,
            })
          )
          return { ready: true, cold_start_ms, started, at: Date.now() }
        } catch (error) {
          if (!(error instanceof PoolExhaustedError)) throw error
          if (attempt === 1) {
            await run((kit) =>
              appendAudit(kit, ids, "pool.exhausted", { reason: error.reason })
            )
          }
          return { ready: false, cold_start_ms: 0, started, at: Date.now() }
        }
      })
      ready = got.ready
      if (attempt === 1) askedAt = got.started
      coldStartMs = got.cold_start_ms
      readyAt = got.at
      if (!ready) await step.sleep(`pool full ${attempt}`, "30 seconds")
    }
    // Failing releases the site lock; returning here would hold it for good.
    if (!ready) return fail("pool", "pool.exhausted")

    await step.do("implementing", () =>
      run((kit) => advance(kit, ids, "implementing"))
    )
    // BA4: a planned build's photos draw while the lead writes the shell and
    // the pages (each writer names its slot's planned path). The lead's
    // `write_pages` places each one as its progress row lands and, once the
    // `site.photos` event is written, empties the fields of slots that fell
    // back. Started before "developer", so the recorded step order holds. A
    // step that throws costs the site its photos, not the build: its
    // `site.photos_failed` event tells `write_pages` to stop waiting at once.
    const photos = route.plan
      ? step
          .do("photos", () =>
            run((kit) => makePhotos({ env: this.env, kit, ids }))
          )
          .catch(async (error: unknown) => {
            await step.do("photos failed", () =>
              run((kit) =>
                appendAudit(kit, ids, "site.photos_failed", {
                  reason: String(error).slice(0, 300),
                })
              )
            )
            return null
          })
      : null

    /**
     * The brief and the site's disk, inside whichever step runs the change.
     * The spec and the snapshot are bodies, so they never cross a step
     * boundary (R8). `handedOn` says a quick attempt before this one left
     * the disk at the revision the change starts from, so it is mapped as
     * it is.
     */
    const prepare = async (role: "quick_section" | null, handedOn: boolean) => {
      const briefStarted = Date.now()
      const { brief, origin, kind, from, left, retry } = await run((kit) =>
        kit.withOrg({ orgId: ids.orgId }, async (db) => {
          const [row] = await db
            .select()
            .from(assignments)
            .where(eq(assignments.id, ids.assignmentId))
          if (!row) throw new NonRetryableError("assignment.not_found")
          const choices = await creationChoices(db, ids)
          const snapshot = await takeSnapshot(db, ids, choices.withhold)
          const spec = await issueSpec(db, this.env, row, choices.model)
          // A revise starts from what the site serves (ADR-032), or before
          // the site is live from the owner's draft it was asked on.
          const source =
            row.kind === "site.revise" ? await reviseSource(db, ids) : null
          if (row.kind === "site.revise" && !source) {
            throw new NonRetryableError("site.not_published")
          }
          // The preview this edit superseded built its revision on the disk
          // and may not have marked it yet: it is still taking screenshots.
          const previewed = superseded
            ? await latestRevision(db, superseded)
            : null
          const previous = choices.retry_of
            ? await retryContext(db, choices.retry_of)
            : undefined
          const retryOf = choices.retry_of
            ? {
                of: choices.retry_of,
                mode: buildFailure(await failureReason(db, choices.retry_of))
                  .retry,
              }
            : null
          const built: Brief = {
            spec,
            snapshot,
            goal: row.goal,
            goal_tainted:
              row.kind === "site.revise" || choices.origin === "owner",
            acceptance_criteria: row.acceptanceCriteria,
            restore_key: source?.source_key ?? null,
            map: null,
            ...(role ? { role } : {}),
            blueprint: Blueprint.safeParse(row.blueprint).data ?? null,
            // The section lane's short prompt reads the site's last plan.
            ...(role === "quick_section"
              ? { site_plan: await latestBlueprint(db) }
              : {}),
            ...(previous ? { previous } : {}),
            ...(retryOf?.mode === "fallback_model" ? { fallback: true } : {}),
          }
          return {
            brief: built,
            origin: choices.origin,
            kind: row.kind,
            from: source?.revision_id ?? null,
            left: previewed?.status === "preview" ? previewed.id : null,
            retry: retryOf,
          }
        })
      )
      // The retry of failed checks starts from the site the failed build left.
      const carried =
        retry?.mode === "fix_forward" &&
        (await takeWork(
          this.env.SITES,
          { orgId: ids.orgId, assignmentId: retry.of },
          ids
        ))
      if (carried) {
        brief.restore_key = checkpointKey(ids)
        brief.continues = kind === "site.revise" ? "revise" : "build"
      }
      const briefMs = since(briefStarted)
      const restoreStarted = Date.now()
      // The container is provisioned. A warm one that holds the revision this
      // assignment starts from is mapped as it is; anything else on the disk
      // is replaced. The site's map goes into the stable segment before the
      // Developer's first turn.
      const sandbox = sandboxFor(this.env, ids.orgId)
      // Always taken, so a first build clears the marker too.
      let held = handedOn ? from : await takeWarm(sandbox)
      if (
        !held &&
        left &&
        (await sandbox.exec(`test -d ${SITE_ROOT}/.git`)).exitCode === 0
      ) {
        held = left
      }
      const warm = !carried && from !== null && held === from
      if (brief.restore_key) {
        brief.map = warm
          ? await mapSite(sandbox)
          : await restoreAndMap(sandbox, this.env.SITES, brief.restore_key)
      } else {
        // A first build seeds an empty site; a warm disk's site would linger.
        await sandbox.exec(`rm -rf ${SITE_ROOT}`)
      }
      return {
        brief,
        origin,
        kind,
        warm,
        brief_ms: briefMs,
        restore_ms: since(restoreStarted),
        dispatched_at: Date.now(),
      }
    }

    // The admission in one step, create-only, so a retried step cannot admit
    // the Developer twice: the second attempt finds the instance and returns.
    const admit = (role: "quick_section" | null, handedOn: boolean) =>
      step.do("developer", async () => {
        const { brief, ...timing } = await prepare(role, handedOn)
        const origin = timing.origin
        try {
          const receipt = await init(Developer, {
            id: ids.assignmentId,
            uid: null,
          }).dispatch({
            // An owner's words are data, not an instruction: a revise's change
            // request and an owner's build goal travel as a signal, tainted on
            // the log (§28.3). A console goal keeps its plain message.
            message: brief.goal_tainted
              ? {
                  kind: "signal",
                  type: "site.change_requested",
                  body: brief.goal,
                  attributes: { taint: "untrusted_input" },
                }
              : `Build the site from the canonical facts. ${brief.goal}`,
            initialData: brief,
          })
          return { submission_id: receipt.submissionId, ...timing, origin }
        } catch (error) {
          if (error instanceof AgentInstanceExistsError) {
            return { submission_id: null, ...timing, origin }
          }
          throw error
        }
      })

    // QE4, the quick lane. A copy or style change is one model call and one
    // build, with no Developer; a section change is the Developer at low
    // effort. Whatever fails moves one lane up: copy and style to section,
    // section to the full build role. The owner sees no failure for a lane.
    const oneCall =
      route.lane === "quick" &&
      (route.change_kind === "copy" ||
        route.change_kind === "style" ||
        route.change_kind === "photo")
        ? route.change_kind
        : null
    /** The Developer runs at the section role and moves to the build role on trouble. */
    let section = route.lane === "quick" && route.change_kind === "section"
    let pending: DeveloperEvent | null = null
    let quickBase: string | null = null
    let quick: "done" | "fell" | null = null
    let admitted: Awaited<ReturnType<typeof admit>>
    if (oneCall) {
      const tried = await step.do("quick edit", async () => {
        const { brief, ...timing } = await prepare(null, false)
        const result = await run((kit) =>
          quickEdit({
            env: this.env,
            kit,
            sandbox: tailSandbox(sandboxFor(this.env, ids.orgId)),
            brief,
            kind: oneCall,
          })
        )
        if (!result.done) {
          await run((kit) =>
            appendAudit(kit, ids, "quick.fell_through", {
              from: oneCall,
              to: "section",
              reason: result.reason,
            })
          )
        }
        return { submission_id: null, ...timing, result }
      })
      admitted = tried
      if (tried.result.done) {
        quick = "done"
        quickBase = tried.result.base
        pending = {
          kind: "completion",
          report_id: tried.result.report_id,
          revision_id: tried.result.revision_id,
          timings: tried.result.timings,
        }
      } else {
        quick = "fell"
        section = true
        admitted = await admit("quick_section", true)
      }
    } else {
      admitted = await admit(section ? "quick_section" : null, false)
    }
    /** The resume and repair signals' attributes that move a section run to the build role, once. */
    const escalate = (): Record<string, string> => {
      if (!section) return {}
      section = false
      return { role: "build" }
    }

    // The nanoclaw pair (§8.3): the tools wake this Workflow with an id, the
    // Workflow answers the Developer with a new submission.
    let resumes = 0
    const resumedFor = new Set<string>()
    let looks = 0
    let asked: Fix[] = []
    let shotsOf: { revision_id: string; taken: number; ms: number } | null =
      null
    for (let round = 1; round <= ROUNDS; round++) {
      let woke: { payload: DeveloperEvent }
      if (pending) {
        // The quick edit's own completion, already reported: no wait.
        woke = { payload: pending }
        pending = null
      } else {
        // The watchdog: a wait that times out looks at the build's log. A
        // lead still working logs every model call and tool, so it waits
        // again for what is left of the window; one that logged nothing for
        // all of it is stopped, and resumed below as an interrupted one.
        let wait = STALL_QUIET_MS
        let got: { payload: DeveloperEvent } | null = null
        for (let n = 1; !got; n++) {
          try {
            got = await step.waitForEvent<DeveloperEvent>(
              n === 1 ? `developer ${round}` : `developer ${round}.${n}`,
              { type: "developer", timeout: wait }
            )
          } catch {
            const quiet = await step.do(`quiet ${round}.${n}`, async () => {
              const at = await run((kit) =>
                kit.withOrg({ orgId: ids.orgId }, (db) =>
                  lastEventAt(db, ids.assignmentId)
                )
              )
              const quietMs = Date.now() - at
              // Stopped in this step, so a replay never stops the resumed run.
              if (quietMs >= STALL_QUIET_MS) {
                await init(Developer, { id: ids.assignmentId }).abort()
              }
              return quietMs
            })
            if (quiet >= STALL_QUIET_MS) {
              got = {
                payload: { kind: "interrupted", reason: DEVELOPER_STALLED },
              }
            } else {
              wait = STALL_QUIET_MS - quiet
            }
          }
        }
        woke = got
      }
      const payload = woke.payload
      // The lead ended its turn with no report the tool accepted, no
      // question and no failure: it gave up, ran out of turns or was
      // refused every time. Nothing will wake this build again.
      if (payload.kind === "unreported") {
        return fail(`unreported ${round}`, "developer.no_report")
      }
      // The lead threw before its first turn (its agent or tools could not be
      // built). A resume builds the same agent, so the build ends here.
      if (payload.kind === "start_failed") {
        return fail(`start ${round}`, "developer.start_failed")
      }
      if (payload.kind === "interrupted") {
        // One failure told twice (a second isolate, a redelivered event) is one
        // resume, not two: a repeat would spend the resume budget for nothing.
        if (payload.key && resumedFor.has(payload.key)) continue
        if (payload.key) resumedFor.add(payload.key)
        const reason = GATE_REASONS.has(payload.reason)
          ? payload.reason
          : "provider.unavailable"
        if (resumes >= RESUMES) return fail(`interrupted ${round}`, reason)
        resumes++
        // The last resume before failing runs on the fallback model, and only
        // for a provider failure: a replaced sandbox or a repeating tool
        // failure is not the model's fault (open item 50, architect ruling).
        const fallback =
          resumes === RESUMES && reason === "provider.unavailable"
        // Outside the step, so a replay flips `section` the same way.
        const lift = escalate()
        await step.sleep(`resume wait ${round}`, "30 seconds")
        await step.do(`resume run ${round}`, async () => {
          await init(Developer, { id: ids.assignmentId }).dispatch({
            idempotencyKey: `${ids.assignmentId}:resume-run-${round}`,
            message: {
              kind: "signal",
              type: "run.interrupted",
              body: JSON.stringify({ reason: payload.reason }),
              attributes: {
                attempt: String(resumes),
                ...lift,
                ...(fallback
                  ? { model: "fallback", reason: payload.reason }
                  : {}),
              },
            },
          })
          // After the resume is sent, and never failing it: a retried step's
          // note is the same row and its chat line the same message.
          await run((kit) =>
            noteResumed(this.env, kit, ids, {
              attempt: resumes,
              of: RESUMES,
              reason: payload.reason,
            })
          ).catch(() => undefined)
          return { resumed: resumes, fallback }
        })
        continue
      }
      if (payload.kind === "completion") {
        // Settled already: `write_pages` waited for its event. Awaited so the
        // step never outlives the instance.
        await photos
        // Axe over this revision's build, from the sandbox the build still
        // holds. Null when a newer edit took the sandbox, which fails the gate.
        const axeOf = () =>
          whileHeld(this.env, ids, () => {
            const sandbox = tailSandbox(sandboxFor(this.env, ids.orgId))
            return runAxe(
              {
                exec: (command) =>
                  sandbox.exec(`cd ${SITE_ROOT} && ${command}`, {
                    timeoutMs: 180_000,
                  }),
                readFileBuffer: sandbox.readFileBuffer,
              },
              this.env.SITES,
              `sites/${ids.orgId}/${payload.revision_id}/`
            )
          })
        // Set by the look below when it ran axe on this very build.
        let looked: Awaited<ReturnType<typeof axeOf>> | undefined
        // BA5: a planned build is looked at before the gates, while the
        // sandbox still holds it and the state is still `implementing`, so a
        // repair is a signal and costs none of the gate repairs. The first
        // look may send the lead back once; the second records which fixes
        // held. Advice only: it never fails a build, and the gates decide.
        if (route.plan && looks < 2) {
          looks++
          const look = looks as 1 | 2
          const seen = await step.do(`critique ${look}`, async () => {
            const taken = await takeScreenshots(
              this.env,
              ids,
              payload.revision_id
            )
            // Axe runs in the sandbox while the critic's model call, which
            // does not touch it, is in flight: the a11y gate costs the first
            // preview no wall time. A look that sends the lead back changes
            // the build, and its axe run is dropped with it.
            const [result, axe] = await Promise.all([
              run((kit) =>
                critiqueRound({
                  env: this.env,
                  kit,
                  ids,
                  round: look,
                  revisionId: payload.revision_id,
                  earlier: asked,
                  // The fields and variants each fix names, before and after the lead's round.
                  readSource: () =>
                    whileHeld(this.env, ids, async () => {
                      const file = await sandboxFor(
                        this.env,
                        ids.orgId
                      ).readFile(`${SITE_ROOT}/src/site-config.ts`)
                      return file.content
                    }),
                })
              ),
              axeOf().catch(() => undefined),
            ])
            return {
              ...result,
              axe,
              shots: { revision_id: payload.revision_id, ...taken },
            }
          })
          shotsOf = seen.shots
          looked = seen.axe
          if (look === 1 && seen.fixes.length > 0) {
            asked = seen.fixes
            await step.do(`design repair ${round}`, async () => {
              await init(Developer, { id: ids.assignmentId }).dispatch({
                idempotencyKey: `${ids.assignmentId}:design-repair-${round}`,
                message: {
                  kind: "signal",
                  type: "design.critique",
                  body: repairMessage(seen.fixes),
                },
              })
              return { fixes: seen.fixes.length }
            })
            continue
          }
          // Nothing to repair, or this was the check: no second look.
          looks = 2
        }
        await step.do(`validating ${round}`, () =>
          run((kit) =>
            advance(kit, ids, "validating", {
              payload: {
                report_id: payload.report_id,
                revision_id: payload.revision_id,
              },
            })
          )
        )
        // The accessibility gate comes before the preview, so a build never
        // announces one and then repairs it. The look above ran axe already
        // when this build was planned; any other build (the quick lane, a
        // repair round) has nothing to overlap it with and runs it here, in
        // `validating`, where the owner already reads "Checking the site".
        // A quick edit's first pass is the exception: it runs axe after its
        // preview instead (owner's choice), and a failure there goes to the
        // section lane, whose repair rounds run axe before the preview.
        const late = quickBase !== null
        const axe = late
          ? undefined
          : looked !== undefined
            ? looked
            : await step.do(`a11y ${round}`, async () => axeOf())
        const gated = await step.do(`gates ${round}`, async () => {
          const gateMs: Record<string, number> = {}
          const started = Date.now()
          const result = await run((kit) =>
            validateRevision(
              kit,
              this.env.SITES,
              ids,
              {
                report_id: payload.report_id,
                revision_id: payload.revision_id,
                axe: late ? "later" : (axe ?? null),
              },
              this.env.SITE_HOST_SUFFIX,
              gateMs
            )
          )
          return {
            ...result,
            gate_ms: { ...gateMs, total: since(started) },
            at: Date.now(),
          }
        })
        // The quick edit's accessibility gate, once its preview exists: axe in
        // the sandbox takes about ten seconds, which the preview does not wait
        // on. The review below does, and so do the approval and the publish.
        const a11y =
          late && gated.outcome === "preview_ready"
            ? await step.do(`a11y ${round}`, async () => {
                const started = Date.now()
                const ran = await axeOf()
                const result = await run((kit) =>
                  checkA11y(kit, this.env.SITES, ids, payload.revision_id, ran)
                )
                return { ...result, ms: since(started) }
              })
            : null
        const verdict =
          a11y && a11y.outcome !== "preview_ready"
            ? { ...gated, ...a11y }
            : gated
        if (verdict.outcome === "repairing" && quickBase) {
          // The quick edit failed a gate: its files go back to where it
          // started and the Developer takes the change at the section role.
          const base = quickBase
          quickBase = null
          await step.do("quick reset", async () => {
            const reset = await sandboxFor(this.env, ids.orgId).exec(
              `cd ${SITE_ROOT} && ${GIT} reset -q --hard ${base}`
            )
            if (reset.exitCode !== 0) throw new Error(reset.stderr)
            await run((kit) =>
              appendAudit(kit, ids, "quick.fell_through", {
                from: oneCall,
                to: "section",
                reason: "gates",
                failed: verdict.failed,
              })
            )
            return { base }
          })
          quick = "fell"
          section = true
          admitted = await admit("quick_section", true)
          // A fall-through for axe carries its findings (rule, impact, page,
          // targets, summary, html) to the Developer, who reruns the gate's
          // script until it is clean.
          if (a11y?.outcome === "repairing") {
            await step.do(`a11y handoff ${round}`, async () => {
              await init(Developer, { id: ids.assignmentId }).dispatch({
                idempotencyKey: `${ids.assignmentId}:a11y-handoff-${round}`,
                message: {
                  kind: "signal",
                  type: "validation.failed",
                  body: JSON.stringify({
                    report_id: a11y.report_id,
                    failed: a11y.failed,
                  }),
                  attributes: { report_id: a11y.report_id },
                },
              })
              return { report_id: a11y.report_id }
            })
          }
          continue
        }
        if (verdict.outcome === "repairing") {
          // The failed rows go back to the same conversation, the way an
          // answer does; the Developer fixes them and reports again.
          const lift = escalate()
          await step.do(`repair ${round}`, async () => {
            await run((kit) => noteProblem(kit, ids, verdict.failed))
            await init(Developer, { id: ids.assignmentId }).dispatch({
              idempotencyKey: `${ids.assignmentId}:repair-${round}`,
              message: {
                kind: "signal",
                type: "validation.failed",
                body: JSON.stringify({
                  report_id: verdict.report_id,
                  failed: verdict.failed,
                }),
                attributes: { report_id: verdict.report_id, ...lift },
              },
            })
            return { report_id: verdict.report_id }
          })
          continue
        }
        // ADR-032: the build's work ends here, not at publish. A preview
        // leaves the site's sandbox warm for the next edit; anything else
        // destroys it.
        const warmAfter = verdict.outcome === "preview_ready"
        // An owner's build goes in front of the owner as soon as the preview
        // exists, so the 72 h clock starts then. `requestReview` answers a
        // retry with the request it already holds. A build superseded or
        // cancelled since the gates has nothing to review and ends as it is.
        // The console asks for its own review, so its builds stop at
        // `preview_ready` as before.
        let reviewed = false
        if (warmAfter && admitted.origin === "owner") {
          const opened = await step.do("review", () =>
            run(async (kit) => {
              try {
                const { request } = await requestReview(kit, ids)
                return { approval_id: request.approval_id }
              } catch (error) {
                if (
                  error instanceof TransitionError &&
                  error.code === "assignment.not_previewable"
                ) {
                  return { approval_id: null }
                }
                throw error
              }
            })
          )
          reviewed = opened.approval_id !== null
        }
        // The screenshots come after the preview exists, not before it: the
        // review card above is already in front of the owner, and the
        // router serves each image once it lands. The sandbox is still the
        // build's own here, which `keep warm` ends.
        const shots = warmAfter
          ? shotsOf?.revision_id === payload.revision_id
            ? shotsOf
            : await step.do("screenshots", () =>
                takeScreenshots(this.env, ids, payload.revision_id)
              )
          : null
        const kept =
          verdict.outcome === "failed" &&
          (await keepWork("gates.repair_budget_exhausted"))
        const endMs = await step.do(
          warmAfter ? "keep warm" : "destroy sandbox",
          async () => {
            const started = Date.now()
            if (warmAfter) {
              await keepWarm(this.env, ids, payload.revision_id)
            } else await endSandbox(this.env, ids)
            return since(started)
          }
        )
        const done = Date.now()
        const t = payload.timings
        logTiming({
          assignment_id: ids.assignmentId,
          org_id: ids.orgId,
          kind: admitted.kind,
          lane: route.lane ?? "full",
          change_kind: route.change_kind ?? null,
          quick,
          outcome: verdict.outcome,
          rounds: round,
          warm: admitted.warm,
          lock_ms: claimedAt - t0,
          // Planning and the owner's wait on the Blueprint come before the
          // container, so they are their own line.
          plan_ms: askedAt - claimedAt,
          provision_ms: readyAt - askedAt,
          cold_start_ms: coldStartMs,
          brief_ms: admitted.brief_ms,
          restore_ms: admitted.restore_ms,
          // Dispatch to report_complete, less the tool's own time: the agent's
          // restore, its model turns and every tool it ran. It includes any
          // wait on an owner's answer.
          agent_ms: t
            ? t.reported_at - admitted.dispatched_at - t.tool_ms
            : null,
          model_turns: t?.model_turns ?? null,
          check_ms: t?.check_ms ?? null,
          build_ms: t?.build_ms ?? null,
          // The preview exists once the gates step returns; everything after
          // is the owner's wait for screenshots and the warm keep.
          preview_ready_ms:
            verdict.outcome === "preview_ready" ? verdict.at - t0 : null,
          screenshots_ms: shots?.ms ?? null,
          screenshots_taken: shots?.taken ?? null,
          upload_ms: t?.upload_ms ?? null,
          upload_files: t?.upload_files ?? null,
          upload_reused: t?.upload_reused ?? null,
          upload_bytes: t?.upload_bytes ?? null,
          source_ms: t?.source_ms ?? null,
          axe_ms: a11y?.ms ?? axe?.ms ?? null,
          gates_ms: verdict.gate_ms.total,
          ...Object.fromEntries(
            Object.entries(verdict.gate_ms)
              .filter(([k]) => k !== "total")
              .map(([k, v]) => [`gate_${k}_ms`, v])
          ),
          [warmAfter ? "keep_warm_ms" : "destroy_ms"]: endMs,
          end_to_end_ms: done - t0,
        })
        if (verdict.outcome === "failed") await followUp(kept)
        // Last, so a chat busy for days holds up nothing.
        if (reviewed) {
          try {
            const note = await step.do("ready note", () =>
              run((kit) => readyNote(this.env, kit, ids))
            )
            if (note) {
              await step.do("say ready", SAY_RETRIES, () =>
                run((kit) => sayReady(kit, ids, note))
              )
            }
          } catch {
            // The ready card says it as well; the chat misses one line.
          }
        }
        return { outcome: verdict.outcome }
      }
      if (payload.kind === "budget") {
        await step.do(`park ${round}`, () =>
          run((kit) =>
            parkForBudget(kit, ids, {
              cap_usd: payload.cap_usd,
              spent_usd: payload.spent_usd,
            })
          )
        )
        return { outcome: "blocked_on_approval" }
      }
      await step.do(`blocked ${round}`, () =>
        run((kit) =>
          advance(kit, ids, "blocked_on_information", {
            payload: { request_id: payload.request_id },
          })
        )
      )
      // Before the container can sleep: a stopped container keeps no disk,
      // and the answer may take days. The rehydrate puts the site back only
      // when the container lost it, so a quick answer costs one tarball.
      const saved = await step.do(`checkpoint ${round}`, async () => {
        const taken = await checkpoint(this.env, ids)
        await run((kit) => appendAudit(kit, ids, "sandbox.checkpointed", taken))
        return taken
      })
      // Nothing to come back to: the container slept before the checkpoint
      // ran. An answer could not resume this build, so end it here rather
      // than leave the owner waiting on a question that leads nowhere.
      if (!saved.taken) return fail(`lost ${round}`, "sandbox.site_lost")
      // One deadline for the round, from a step so a replay reads the same.
      const deadline = await step.do(
        `deadline ${round}`,
        async () => Date.now() + ANSWER_DEADLINE_MS
      )
      // The assistant answers what it already knows; only the rest is put
      // to the owner, as a card in the chat.
      const relayed = await step.do(`relay ${round}`, () =>
        run((kit) => relayQuestion(this.env, kit, ids, payload.request_id))
      )
      const ask = relayed && "ask" in relayed ? relayed.ask : null
      let posted = ask === null
      let factId = ""
      for (let look = 1; ; look++) {
        // The clock is read inside the step too, so a replay takes the same
        // branch below.
        const seen = await step.do(`look ${round}.${look}`, async () => {
          const [waited] = await run((kit) =>
            kit.withOrg({ orgId: ids.orgId }, (db) =>
              waitedOn(db, ids.assignmentId)
            )
          )
          // The answered fact's current version: an edit made since the
          // answer is what the Developer should see.
          const answered =
            waited?.request.request_id === payload.request_id
              ? (waited.fact_id ?? "")
              : ""
          // The card, until the chat takes it: a busy chat, or one waiting
          // on another card, is tried again at the next look.
          const shown =
            posted ||
            Boolean(answered) ||
            ask === null ||
            !QUEUED.has(
              await run((kit) =>
                askOwner(kit, ids, payload.request_id, ask)
              ).then((p) => p ?? "posted")
            )
          return { factId: answered, left: deadline - Date.now(), shown }
        })
        factId = seen.factId
        posted = seen.shown
        if (factId) break
        // Seven days with no answer. `fail` releases the site lock and takes
        // the checkpoint out of R2 with the container.
        if (seen.left <= 0) {
          return fail(`unanswered ${round}`, "information.unanswered")
        }
        try {
          await step.waitForEvent(`answer ${round}.${look}`, {
            type: "answer",
            timeout: Math.min(
              posted ? LOOK_EVERY_MS : POST_AGAIN_MS,
              seen.left
            ),
          })
        } catch {
          // No nudge in time: look anyway.
        }
      }
      await step.do(`rehydrate ${round}`, async () => {
        const result = await rehydrate(this.env, ids)
        await run((kit) => appendAudit(kit, ids, "sandbox.rehydrated", result))
        return result
      })
      await step.do(`resume ${round}`, async () => {
        const fact = await run((kit) =>
          kit.withOrg({ orgId: ids.orgId }, async (db) => {
            const [row] = await db
              .select()
              .from(facts)
              .where(eq(facts.id, factId))
            if (!row) throw new NonRetryableError("fact.not_found")
            return toFactRecord(row)
          })
        )
        await run((kit) =>
          advance(kit, ids, "implementing", {
            payload: { request_id: payload.request_id, fact_id: factId },
          })
        )
        // The Developer never sees "the owner said"; it sees a fact record.
        await init(Developer, { id: ids.assignmentId }).dispatch({
          idempotencyKey: `${ids.assignmentId}:resume-${round}`,
          message: {
            kind: "signal",
            type: "information.answered",
            body: JSON.stringify({ request_id: payload.request_id, fact }),
            attributes: { field: fact.key },
          },
        })
        // What the owner asked for while it waited, after the answer, as the
        // steer route would have sent it.
        const steers = await run((kit) =>
          kit.withOrg({ orgId: ids.orgId }, (db) =>
            heldSteers(db, ids.assignmentId)
          )
        )
        for (const held of steers) {
          await init(Developer, { id: ids.assignmentId }).dispatch({
            idempotencyKey: `${ids.assignmentId}:held-${held.event_id}`,
            message: held.owner
              ? {
                  kind: "signal",
                  type: "site.change_requested",
                  body: held.message,
                  attributes: { taint: "untrusted_input" },
                }
              : { kind: "user", body: held.message },
          })
        }
        return { fact_id: fact.fact_id }
      })
    }
    return { outcome: "rounds_exhausted" }
  }
}

/** One audit row for a step that moves no state. */
function appendAudit(
  kit: Tenancy,
  ids: { orgId: string; assignmentId: string | null },
  type: string,
  payload: Record<string, unknown>
) {
  return kit.withOrg({ orgId: ids.orgId }, (db) =>
    appendEvent(db, {
      orgId: ids.orgId,
      assignmentId: ids.assignmentId,
      staffId: null,
      type,
      payload,
    })
  )
}

/**
 * The publisher (ADR-032): one instance per approval, keyed by the approval
 * id so a second create is refused, or per rollback request, keyed by its
 * idempotency key. Every step body is in publish.ts; this is the order.
 */
export class PublishWorkflow extends WorkflowEntrypoint<Env, PublishParams> {
  async run(event: WorkflowEvent<PublishParams>, step: WorkflowStep) {
    const params = event.payload
    const orgId = params.org_id
    const run = <T>(fn: (kit: Tenancy) => Promise<T>) => withKit(this.env, fn)
    const rollback = "rollback" in params

    // The ids this instance's activations take, minted once and kept with
    // the step, so a retried activation finds its own row and no other.
    const target = await step.do("read target", async () => ({
      ...(await run((kit) =>
        kit.withOrg({ orgId }, (db) => readTarget(db, this.env, params))
      )),
      activation_id: crypto.randomUUID(),
      rollback_id: crypto.randomUUID(),
    }))

    const artifact = await step.do("verify artifact", async () => {
      const files = await verifyArtifact(
        this.env.SITES,
        target.site_id,
        target.revision_id
      )
      if (!files.ok) return files
      // The accessibility gate runs after the preview; no pass, no publish.
      const passed = await run((kit) =>
        kit.withOrg({ orgId }, (db) => accessible(db, target.revision_id))
      )
      return passed
        ? files
        : {
            ok: false as const,
            message: "the revision has no passing accessibility check",
          }
    })
    if (!artifact.ok) {
      await step.do("refuse", () =>
        run((kit) =>
          appendAudit(
            kit,
            { orgId, assignmentId: target.assignment_id },
            "publish.refused",
            { revision_id: target.revision_id, reason: artifact.message }
          )
        )
      )
      return { outcome: "refused", reason: artifact.message }
    }

    const deployment = await step.do("activate", () =>
      run((kit) =>
        kit.withOrg({ orgId }, async (db) => {
          const row = await activate(db, orgId, {
            id: target.activation_id,
            siteId: target.site_id,
            revisionId: target.revision_id,
            kind: rollback ? "rollback" : "publish",
            approvalId:
              "approval_id" in params ? params.approval_id : undefined,
            assignmentId: target.assignment_id ?? undefined,
            reason: "rollback" in params ? params.rollback.reason : undefined,
            // A rollback replaces the deployment it read as live, or nothing.
            over: target.live_deployment_id ?? undefined,
          })
          if (!row) {
            await stillLive(
              db,
              orgId,
              target,
              target.live_deployment_id,
              "activate"
            )
            return null
          }
          return {
            deployment_id: row.id,
            config_version: row.configVersion,
            previous_revision_id: row.previousRevisionId,
          }
        })
      )
    )

    // A rollback request that found a newer deployment activated nothing:
    // no pointer and no probes, and the same ending as every other path.
    let superseded = !deployment
    const point = () =>
      run((kit) =>
        writePointer(this.env, kit, orgId, target.site_id, target.host)
      )
    // The host the site is served on: its custom domain once one is active.
    const served = deployment
      ? (await step.do("pointer", point)).host
      : target.host

    // The content gate runs on the live HTML with the facts the assignment
    // was validated against; a rollback has no assignment and takes the
    // 5xx and blank-page checks alone. A page the router served from another
    // revision is never judged. Once another deployment holds the site, this
    // instance stops: it neither alerts nor rolls back, and the newer one
    // probes itself.
    let failed: { minute: number; reason: string; not_served?: string } | null =
      null
    for (const [i, minute] of PROBE_MINUTES.entries()) {
      if (!deployment) break
      if (i > 0) {
        const previous = PROBE_MINUTES[i - 1] ?? 0
        await step.sleep(
          `until minute ${minute}`,
          `${minute - previous} minutes`
        )
      }
      const result = await step.do(`probe ${minute}`, async () => {
        const assignmentId = target.assignment_id
        const factRecords = assignmentId
          ? await run((kit) => assignmentFacts(kit, { orgId, assignmentId }))
          : null
        const probe = await probeHost(
          served,
          factRecords,
          undefined,
          {
            revision_id: target.revision_id,
            config_version: deployment.config_version,
            proof: await probeProof(served, this.env.PREVIEW_KEY),
          },
          undefined,
          this.env.SITE_PORT
        )
        return run((kit) =>
          kit.withOrg({ orgId }, async (db) => {
            const at = `probe ${minute}`
            if (
              !(await stillLive(
                db,
                orgId,
                target,
                deployment.deployment_id,
                at
              ))
            ) {
              return { superseded: true as const }
            }
            await appendEvent(db, {
              orgId,
              assignmentId: target.assignment_id,
              staffId: null,
              type: "publish.probed",
              payload: { minute, revision_id: target.revision_id, ...probe },
            })
            return probe
          })
        )
      })
      if ("superseded" in result) {
        superseded = true
        break
      }
      if (!result.ok) {
        failed = { minute, ...result }
        break
      }
      // A first version going live is news the owner hears in the chat.
      if (i === 0 && !rollback && !deployment.previous_revision_id) {
        try {
          await step.do("say live", LIVE_SAY, () =>
            run((kit) =>
              sayLive(
                this.env,
                kit,
                orgId,
                target.site_id,
                siteUrl(served, this.env.SITE_PORT)
              )
            )
          )
        } catch {
          // The panel says the site is live as well; the chat misses one line.
        }
      }
    }

    // Search engines hear about a version that stayed live (search-sync.ts).
    // The body never throws; a step that still fails leaves the publish as is.
    if (deployment && !failed && !superseded) {
      try {
        await step.do("search", () =>
          run((kit) =>
            afterPublish(this.env, kit, {
              orgId,
              host: served,
              siteId: target.site_id,
              revisionId: target.revision_id,
              previousRevisionId: deployment.previous_revision_id,
            })
          )
        )
      } catch {
        // Logged in the body; the next publish and the daily sync catch up.
      }
    }

    // A rollback restores what this instance's own row replaced, only while
    // that row is still live.
    // A version the router never served is not known to be broken: an
    // alert, never a rollback.
    const back = deployment?.previous_revision_id
    let rolledBack = false
    if (failed && !failed.not_served && !rollback && deployment && back) {
      const why = failed
      const undone = await step.do("roll back", () =>
        run((kit) =>
          kit.withOrg({ orgId }, async (db) => {
            const row = await activate(db, orgId, {
              id: target.rollback_id,
              siteId: target.site_id,
              revisionId: back,
              kind: "rollback",
              reason: `probe ${why.minute}: ${why.reason}`,
              over: deployment.deployment_id,
            })
            if (!row) {
              await stillLive(
                db,
                orgId,
                target,
                deployment.deployment_id,
                "roll back"
              )
              return null
            }
            await appendEvent(db, {
              orgId,
              assignmentId: target.assignment_id,
              staffId: null,
              type: "alert.raised",
              payload: {
                kind: "publish.rolled_back",
                revision_id: target.revision_id,
                restored_revision_id: back,
                minute: why.minute,
                reason: why.reason,
              },
            })
            return true
          })
        )
      )
      if (undone) {
        await step.do("pointer after rollback", point)
        rolledBack = true
      } else superseded = true
    } else if (failed && deployment) {
      const why = failed
      const alerted = await step.do("alert", () =>
        run((kit) =>
          kit.withOrg({ orgId }, async (db) => {
            if (
              !(await stillLive(
                db,
                orgId,
                target,
                deployment.deployment_id,
                "alert"
              ))
            ) {
              return false
            }
            await appendEvent(db, {
              orgId,
              assignmentId: target.assignment_id,
              staffId: null,
              type: "alert.raised",
              payload: {
                kind: why.not_served
                  ? "publish.not_served"
                  : "publish.probe_failed",
                revision_id: target.revision_id,
                minute: why.minute,
                reason: why.reason,
                ...(why.not_served ? { served: why.not_served } : {}),
              },
            })
            return true
          })
        )
      )
      if (!alerted) superseded = true
    }

    // Retention (ADR-031), after the probes and any rollback so the active
    // and previous revisions are read as they stand now, never from the
    // target this instance opened with. A failed mark is corrected by the
    // next publish and never fails a release.
    await step.do("retire others", () =>
      run((kit) =>
        kit.withOrg({ orgId }, async (db) => ({
          retired: await retireOthers(db, target.site_id),
        }))
      )
    )

    // A publish ends a site lock holder (§13): whoever queued behind it runs.
    const redriven = await step.do("redrive queued", () =>
      run((kit) => redriveQueued(this.env, kit, orgId))
    )
    return {
      outcome: superseded
        ? "superseded"
        : !failed
          ? "published"
          : failed.not_served
            ? "unconfirmed"
            : rolledBack
              ? "rolled_back"
              : "alerted",
      revision_id: target.revision_id,
      redriven,
    }
  }
}

/** Orgs per sweep step: idempotent work, so a retried step redoing a finished org changes nothing. */
const SWEEP_CHUNK = 50

/** The UTC hour whose sweep also looks at every live custom domain, once a day. */
export const DOMAIN_SWEEP_HOUR = "06"

/** Matched character for character against the wrangler config. */
export const SWEEP_CRON = "0 * * * *"

/** The hour the sweep runs for, `YYYYMMDDHH`, which is also its instance id's suffix. */
export const sweepHour = (at: number) =>
  new Date(at).toISOString().slice(0, 13).replace(/[-T]/g, "")

/**
 * The hourly sweep (ADR-032): one instance per hour, keyed by the hour so a
 * duplicate is refused, over every org in chunks. Each org parks its expired
 * reviews, re-drives what queued behind a site lock, and deletes the files
 * of every revision past its window through the one guarded delete. An org
 * that throws is logged and counted, and the rest of its chunk and the
 * chunks after it still run.
 *
 * Fan-out is one org at a time, every hour. When orgs pass roughly 500, or
 * a run's wall clock passes an hour, the selection moves to orgs with work
 * due or to one instance per chunk (architect ruling, recorded in ADR-032).
 */
export class SweepWorkflow extends WorkflowEntrypoint<Env, { hour: string }> {
  async run(event: WorkflowEvent<{ hour: string }>, step: WorkflowStep) {
    const kitFor = () => tenancy(this.env.HYPERDRIVE.connectionString)
    const orgIds = await step.do("list orgs", async () => {
      const kit = kitFor()
      try {
        return await listOrgIds(kit)
      } finally {
        await kit.close()
      }
    })
    const totals = {
      orgs: orgIds.length,
      parked: 0,
      redriven: 0,
      deleted: 0,
      failed: 0,
    }
    for (let i = 0; i < orgIds.length; i += SWEEP_CHUNK) {
      const chunk = orgIds.slice(i, i + SWEEP_CHUNK)
      const counts = await step.do(`sweep ${i / SWEEP_CHUNK + 1}`, async () => {
        const kit = kitFor()
        const sum: SweepCounts & { failed: number } = {
          parked: 0,
          redriven: 0,
          deleted: 0,
          failed: 0,
        }
        try {
          for (const orgId of chunk) {
            try {
              const c = await sweepOrg(this.env, kit, orgId)
              sum.parked += c.parked
              sum.redriven += c.redriven
              sum.deleted += c.deleted
            } catch (error) {
              sum.failed++
              console.error(
                JSON.stringify({
                  sweep: event.payload.hour,
                  org_id: orgId,
                  code: failureCode(error),
                })
              )
            }
          }
        } finally {
          await kit.close()
        }
        return sum
      })
      totals.parked += counts.parked
      totals.redriven += counts.redriven
      totals.deleted += counts.deleted
      totals.failed += counts.failed
    }
    // Once a day, every live custom domain (domain-flow.ts): a hostname that
    // moved or a certificate gone inactive raises one alert, and each message
    // is posted in a step of its own so a busy chat retries the post alone.
    if (event.payload.hour.endsWith(DOMAIN_SWEEP_HOUR)) {
      for (let i = 0; i < orgIds.length; i += SWEEP_CHUNK) {
        const chunk = orgIds.slice(i, i + SWEEP_CHUNK)
        const says = await step.do(
          `domains ${i / SWEEP_CHUNK + 1}`,
          async () => {
            const kit = kitFor()
            const found: { orgId: string; say: Say }[] = []
            try {
              for (const orgId of chunk) {
                try {
                  for (const say of await sweepDomains(
                    this.env,
                    kit,
                    orgId,
                    event.payload.hour
                  )) {
                    found.push({ orgId, say })
                  }
                } catch (error) {
                  console.error(
                    JSON.stringify({
                      sweep: event.payload.hour,
                      org_id: orgId,
                      code: failureCode(error),
                    })
                  )
                }
              }
            } finally {
              await kit.close()
            }
            return found
          }
        )
        for (const { orgId, say } of says) {
          try {
            await step.do(`say ${say.key}`, SAY_RETRIES, () =>
              withKit(this.env, (kit) => postStatus(kit, orgId, say))
            )
          } catch {
            // The chat stayed busy past every retry; the alert row keeps it.
          }
        }
      }
    }
    // Search Console (search-sync.ts): each org due a pull gets its own
    // instance, since a sweep calling Google for every org would pass the
    // subrequest limit. The Monday report is a heartbeat item (heartbeat.ts).
    const { hour } = event.payload
    const day = `${hour.slice(0, 4)}-${hour.slice(4, 6)}-${hour.slice(6, 8)}`
    for (let i = 0; i < orgIds.length; i += SWEEP_CHUNK) {
      const chunk = orgIds.slice(i, i + SWEEP_CHUNK)
      await step.do(`search ${i / SWEEP_CHUNK + 1}`, () =>
        withKit(this.env, (kit) => startDueSyncs(this.env, kit, chunk, day))
      )
    }
    // The outbox (deliveries.ts): rows the Queue lost are queued again.
    for (let i = 0; i < orgIds.length; i += SWEEP_CHUNK) {
      const chunk = orgIds.slice(i, i + SWEEP_CHUNK)
      await step.do(`deliveries ${i / SWEEP_CHUNK + 1}`, () =>
        withKit(this.env, async (kit) => {
          for (const orgId of chunk) {
            try {
              await redriveDeliveries(kit, this.env, orgId)
            } catch (error) {
              console.error(
                JSON.stringify({
                  sweep: hour,
                  org_id: orgId,
                  code: failureCode(error),
                })
              )
            }
          }
        })
      )
    }
    // The run's one line, for the alert on a sweep that deletes nothing for a week.
    console.log(JSON.stringify({ sweep: event.payload.hour, ...totals }))
    return totals
  }
}

/**
 * flue forwards every non-HTTP handler exported here into the Worker's
 * default export. Each job runs on the cron that matches its constant, so two
 * jobs on the same schedule share one firing. The hourly cron creates the
 * hour's sweep; a second firing for the same hour is refused by the instance
 * id and swallowed. The uptime check does nothing without `HEALTH_URLS`, which
 * only production sets. Queues are told apart by name, one handler each; a
 * batch from a queue nothing here consumes throws, so it retries and
 * dead-letters rather than being acked unread.
 */
export default {
  async queue(batch: MessageBatch, env: Env) {
    if (JOBS_QUEUES.includes(batch.queue))
      return jobsBatch(batch as MessageBatch<JobsQueueMessage>, env)
    if (DELIVERIES_QUEUES.includes(batch.queue))
      return deliveriesBatch(batch as MessageBatch<DeliveryMessage>, env)
    throw new Error(`no consumer for queue ${batch.queue}`)
  },
  async scheduled(controller: ScheduledController, env: Env) {
    if (controller.cron === SCHEDULE_CRON) await scanDue(env)
    if (controller.cron === SWEEP_CRON) {
      const hour = sweepHour(controller.scheduledTime)
      try {
        await env.SWEEPS.create({ id: `sweep-${hour}`, params: { hour } })
      } catch {
        // Already created for this hour.
      }
    }
    if (controller.cron === UPTIME_CRON) {
      // A router that stops serving verification files alerts before Google drops a property.
      const file = await servedVerification(env).catch(() => null)
      await checkUptime(env, file ? [file] : [])
    }
  },
}
