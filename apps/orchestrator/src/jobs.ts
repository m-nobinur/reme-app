import {
  appendEvent,
  eq,
  failureCode,
  jobRuns,
  lowerNextDue,
  nextFor,
  type OrgScopedDb,
  orgOpen,
  orgs,
  postAssistantMessage,
  scheduledJobs,
  sql,
  type Tenancy,
} from "@workspace/db"
import { scheduledBy } from "@workspace/skills"
import { withKit } from "./domain-flow.ts"
import { heartbeatJob } from "./heartbeat.ts"
import { redriveQueued } from "./publish.ts"
import { reminderJob } from "./reminder-job.ts"
import { type JobMessage, type JobsQueueMessage, scanDue } from "./schedule.ts"

type ScheduledJob = typeof scheduledJobs.$inferSelect

/**
 * One occurrence of a job, as its handler sees it. `db` is the run's own
 * transaction: what the handler writes commits with the `job_runs` row or not
 * at all, so a failed run leaves nothing in Postgres. Anything that leaves
 * Postgres goes through the outbox, and the transaction's 15-second idle limit
 * bounds the work done inside it. `kit` is for `after`, which runs once that
 * transaction is over. `earlierUnknown` is set when the job's last attempt
 * ended with its result unknown, for a handler whose effect leaves Postgres.
 */
export type JobRun = {
  db: OrgScopedDb
  kit: Tenancy
  env: Env
  job: ScheduledJob
  now: Date
  earlierUnknown: boolean
}

/** What a run's `after` step settled, written over the run's outcome. */
export type Settled = {
  outcome: "done" | "no_change" | "failed"
  detail?: string
}

/**
 * Nothing returned means `done`; `no_change` is a run with nothing to say.
 * Throwing is a failure, with backoff, unless it throws `OutcomeUnknown`.
 * `after` runs once the run's transaction has committed and never otherwise,
 * for what must not happen ahead of the commit, such as a Queue send for a
 * row the run wrote, and may return what it settled. If it throws the run
 * still stands; the error is logged.
 */
export type Handler = (run: JobRun) => Promise<
  | {
      outcome: "done" | "no_change"
      detail?: string
      after?: () => Promise<Settled | undefined>
    }
  | undefined
>

/**
 * Thrown by a handler whose effect outside Postgres may have happened before
 * it failed. The run is recorded `unknown`, and the retry is told so.
 */
export class OutcomeUnknown extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "OutcomeUnknown"
  }
}

export type Handlers = Partial<Record<ScheduledJob["kind"], Handler>>

/** The `jobs` Queue's name in each environment, as the wrangler config spells it. */
export const JOBS_QUEUES = ["reme-jobs", "reme-jobs-production"]

/**
 * A `cos_continue` is run by the api, where the CoS lives: the job is handed
 * to its after-turn queue, ids only. Sent inside the run, so a send that
 * fails is retried with the job; the api finds a second hand-over done.
 */
export const continueJob: Handler = async ({ env, job, earlierUnknown }) => {
  try {
    await env.AFTER_TURN.send({
      kind: "cos_continue",
      orgId: job.orgId,
      jobId: job.id,
      ...(earlierUnknown && { unknown: true }),
    })
  } catch (error) {
    // A send that threw may still have been accepted.
    throw new OutcomeUnknown(failureCode(error))
  }
  return undefined
}

/**
 * A `cos_wake` is a proactive CoS turn, run by the api like a `cos_continue`.
 * `slot` is the window's due time, which keys what the turn posts.
 */
export const wakeJob: Handler = async ({ env, job }) => {
  try {
    await env.AFTER_TURN.send({
      kind: "cos_wake",
      orgId: job.orgId,
      jobId: job.id,
      slot: job.nextRunAt.toISOString(),
    })
  } catch (error) {
    // A send that threw may still have been accepted.
    throw new OutcomeUnknown(failureCode(error))
  }
  return undefined
}

/**
 * A procedure's schedule (`weekly_report`) is a proactive CoS turn that
 * follows the procedure, handed to the api as a `cos_wake` naming it.
 */
export const skillJob: Handler = async ({ env, job }) => {
  const skill = scheduledBy(job.kind)
  if (!skill) return { outcome: "no_change", detail: "no procedure" }
  try {
    await env.AFTER_TURN.send({
      kind: "cos_wake",
      orgId: job.orgId,
      jobId: job.id,
      slot: job.nextRunAt.toISOString(),
      skill: skill.name,
    })
  } catch (error) {
    // A send that threw may still have been accepted.
    throw new OutcomeUnknown(failureCode(error))
  }
  return undefined
}

/** One handler per kind, added by the story that adds the kind. */
export const HANDLERS: Handlers = {
  reminder: reminderJob,
  heartbeat: heartbeatJob,
  weekly_report: skillJob,
  cos_continue: continueJob,
  cos_wake: wakeJob,
}

/** Failures in a row before a job turns itself off and the owner is told. */
export const MAX_FAILURES = 10

/** Minutes to wait after the `failures`th failure in a row. */
export const backoffMinutes = (failures: number) => Math.min(60, 2 ** failures)

export const PAUSED_TEXT =
  "Something I was meant to do on a schedule kept failing, so I've paused it. I'll tell you more when I can."

/**
 * What became of a message: the run's outcome; `paused` for the failure that
 * paused it; `closed` when its org was closed; `stale` when there was nothing
 * to run, which is how a redelivered message ends.
 */
export type Ran =
  | "done"
  | "no_change"
  | "failed"
  | "unknown"
  | "paused"
  | "closed"
  | "stale"

/**
 * The job, locked, if this message may still run it: claimed, not paused,
 * and due. A redelivery after the run finds the claim cleared. Due is by
 * Postgres's clock at the claim, so this Worker's clock gets a minute's grace.
 */
async function claimedJob(db: OrgScopedDb, jobId: string, now: Date) {
  const [job] = await db
    .select()
    .from(scheduledJobs)
    .where(eq(scheduledJobs.id, jobId))
    .for("update")
  return job?.claimedAt &&
    !job.pausedAt &&
    job.nextRunAt.getTime() <= now.getTime() + 60_000
    ? job
    : null
}

/**
 * What a started attempt writes in its `job_runs` row's detail: the claim it
 * ran under. A second delivery of the same claim finds it and leaves the
 * attempt alone; a retaken claim means the first attempt's worker is gone.
 */
const startedUnder = (claimedAt: Date) => `claim ${claimedAt.toISOString()}`

/**
 * Runs one claimed job once, in two transactions. The first writes the
 * occurrence's `job_runs` row as `unknown` and commits, so a worker that dies
 * mid-run leaves the mark that its result is not known. The second holds the
 * job's lock, runs the handler and settles the row with what the handler
 * writes. A retaken claim finds the mark and reruns with `earlierUnknown`;
 * so does the next try after a run recorded `unknown`. Success moves
 * `next_run_at` to the rule's next time in the org's zone, or pauses a
 * one-off for good.
 */
export async function runJob(
  kit: Tenancy,
  env: Env,
  { jobId, orgId }: JobMessage,
  handlers: Handlers = HANDLERS,
  now = new Date()
): Promise<Ran> {
  let next: Date | null = null
  let after: (() => Promise<Settled | undefined>) | undefined
  let runAt: Date | undefined
  try {
    const started = await kit.withOrg({ orgId }, async (db) => {
      const job = await claimedJob(db, jobId, now)
      if (!job) return "stale" as const
      if (!(await orgOpen(db))) {
        await db
          .update(scheduledJobs)
          .set({ pausedAt: now, claimedAt: null })
          .where(eq(scheduledJobs.id, jobId))
        return "closed" as const
      }
      const [last] = await db
        .select()
        .from(jobRuns)
        .where(eq(jobRuns.jobId, jobId))
        .orderBy(sql`${jobRuns.runAt} desc`)
        .limit(1)
      const detail = startedUnder(job.claimedAt as Date)
      if (
        last?.runAt.getTime() === job.nextRunAt.getTime() &&
        (last.outcome !== "unknown" || last.detail === detail)
      )
        return "stale" as const
      await db
        .insert(jobRuns)
        .values({
          jobId,
          orgId,
          runAt: job.nextRunAt,
          outcome: "unknown",
          detail,
        })
        .onConflictDoUpdate({
          target: [jobRuns.jobId, jobRuns.runAt],
          set: { detail },
        })
      return { earlierUnknown: last?.outcome === "unknown" }
    })
    if (typeof started === "string") return started
    const ran = await kit.withOrg({ orgId }, async (db): Promise<Ran> => {
      after = undefined
      const job = await claimedJob(db, jobId, now)
      if (!job) return "stale"
      runAt = job.nextRunAt
      const handler = handlers[job.kind]
      const result: Awaited<ReturnType<Handler>> = handler
        ? await handler({ db, kit, env, job, now, ...started })
        : { outcome: "no_change", detail: "no handler" }
      after = result?.after
      const outcome = result?.outcome ?? "done"
      await db
        .update(jobRuns)
        .set({ outcome, detail: result?.detail ?? null })
        .where(
          sql`${eq(jobRuns.jobId, jobId)} and ${eq(jobRuns.runAt, job.nextRunAt)}`
        )
      if (job.rule) {
        const [org] = await db
          .select({
            timeZone: orgs.timeZone,
            quietStart: orgs.quietStart,
            quietEnd: orgs.quietEnd,
          })
          .from(orgs)
        if (!org) throw new Error("jobs.org_unreadable")
        next = nextFor({ kind: job.kind, rule: job.rule }, org, now)
      }
      await db
        .update(scheduledJobs)
        .set({
          lastRunAt: now,
          claimedAt: null,
          failures: 0,
          ...(next ? { nextRunAt: next } : { pausedAt: now }),
        })
        .where(eq(scheduledJobs.id, jobId))
      return outcome
    })
    if (next) await lowerNextDue(env.SCHEDULE, next, env.JOBS)
    // Committed. A failure here leaves the handler's delivery rows pending.
    const settled = await after?.().catch((error: unknown) => {
      console.error(
        JSON.stringify({
          code: "jobs.after_failed",
          job_id: jobId,
          error: failureCode(error),
        })
      )
    })
    if (settled && runAt) {
      const at = runAt
      await kit
        .withOrg({ orgId }, (db) =>
          db
            .update(jobRuns)
            .set({
              outcome: settled.outcome,
              detail: settled.detail?.slice(0, 500) ?? null,
            })
            .where(
              sql`${eq(jobRuns.jobId, jobId)} and ${eq(jobRuns.runAt, at)}`
            )
        )
        .catch((error: unknown) =>
          console.error(
            JSON.stringify({
              code: "jobs.settle_failed",
              job_id: jobId,
              error: failureCode(error),
            })
          )
        )
    }
    return ran
  } catch (error) {
    return failed(kit, env, { jobId, orgId }, error, now)
  }
}

/**
 * The run threw and its transaction rolled back. Record it in a transaction
 * of its own, as `unknown` when the handler says its effect may have
 * happened and `failed` when nothing did, and back off; the tenth in a row
 * pauses the job and tells the owner. If this throws too, the message is
 * retried.
 */
async function failed(
  kit: Tenancy,
  env: Env,
  { jobId, orgId }: JobMessage,
  error: unknown,
  now: Date
): Promise<Ran> {
  const unknown = error instanceof OutcomeUnknown
  const code = unknown ? error.code : failureCode(error)
  console.error(
    JSON.stringify({ code: "jobs.run_failed", job_id: jobId, error: code })
  )
  const after = await kit.withOrg({ orgId }, async (db) => {
    const job = await claimedJob(db, jobId, now)
    if (!job) return null
    const outcome = unknown ? "unknown" : "failed"
    await db
      .insert(jobRuns)
      .values({ jobId, orgId, runAt: job.nextRunAt, outcome, detail: code })
      .onConflictDoUpdate({
        target: [jobRuns.jobId, jobRuns.runAt],
        set: { outcome, detail: code },
      })
    const failures = job.failures + 1
    const paused = failures >= MAX_FAILURES
    const next = new Date(now.getTime() + backoffMinutes(failures) * 60_000)
    await db
      .update(scheduledJobs)
      .set({
        failures,
        claimedAt: null,
        nextRunAt: next,
        ...(paused && { pausedAt: now }),
      })
      .where(eq(scheduledJobs.id, jobId))
    if (paused)
      await appendEvent(db, {
        orgId,
        assignmentId: null,
        staffId: null,
        type: "alert.raised",
        payload: {
          kind: "job.paused",
          job_id: jobId,
          job_kind: job.kind,
          failures,
        },
      })
    return { next, paused, outcome } as const
  })
  if (!after) return "stale"
  if (!after.paused) {
    await lowerNextDue(env.SCHEDULE, after.next, env.JOBS)
    return after.outcome
  }
  // Once per pause. A busy chat drops it; the alert row keeps it.
  const posted = await postAssistantMessage(kit, {
    orgId,
    key: `job-paused:${jobId}:${now.toISOString()}`,
    message: { text: [PAUSED_TEXT] },
  }).catch((e: unknown) => failureCode(e))
  if (posted !== "posted" && posted !== "exists")
    console.error(
      JSON.stringify({ code: "jobs.pause_unposted", job_id: jobId, posted })
    )
  return "paused"
}

/**
 * The `jobs` Queue's consumer. A message whose run cannot be recorded at all
 * (Postgres unreachable) is retried, then dead-lettered; its claim lapses and
 * the cron retakes the job either way. A wake (`lowerNextDue`) scans now and
 * sends what it claims back to this queue.
 */
export async function jobsBatch(
  batch: MessageBatch<JobsQueueMessage>,
  env: Env,
  scan = scanDue,
  redrive = redriveQueued
): Promise<void> {
  await withKit(env, async (kit) => {
    for (const message of batch.messages) {
      const { body } = message
      if ("kind" in body) {
        try {
          if (body.kind === "redrive") await redrive(env, kit, body.orgId)
          else await scan(env, Date.now(), true)
          message.ack()
        } catch (error) {
          console.error(
            JSON.stringify({
              code:
                body.kind === "redrive"
                  ? "jobs.redrive_failed"
                  : "jobs.wake_failed",
              error: failureCode(error),
            })
          )
          message.retry()
        }
        continue
      }
      try {
        const ran = await runJob(kit, env, body)
        console.log(
          JSON.stringify({ type: "jobs.ran", job_id: body.jobId, ran })
        )
        message.ack()
      } catch (error) {
        console.error(
          JSON.stringify({
            code: "jobs.unrecorded",
            job_id: body.jobId,
            error: failureCode(error),
          })
        )
        message.retry()
      }
    }
  })
}
