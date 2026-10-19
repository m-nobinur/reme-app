import {
  appendEvent,
  eq,
  failureCode,
  jobRuns,
  lowerNextDue,
  nextRun,
  type OrgScopedDb,
  orgOpen,
  orgs,
  postAssistantMessage,
  scheduledJobs,
  sql,
  type Tenancy,
} from "@workspace/db"
import { withKit } from "./domain-flow.ts"
import { reminderJob } from "./reminder-job.ts"
import type { JobMessage } from "./schedule.ts"

type ScheduledJob = typeof scheduledJobs.$inferSelect

/**
 * One occurrence of a job, as its handler sees it. `db` is the run's own
 * transaction: what the handler writes commits with the `job_runs` row or not
 * at all, so a crash mid-run leaves nothing and the job is retaken when its
 * claim lapses. Anything that leaves Postgres goes through the outbox, and
 * the transaction's 15-second idle limit bounds the work done inside it.
 */
export type JobRun = {
  db: OrgScopedDb
  env: Env
  job: ScheduledJob
  now: Date
}

/**
 * Nothing returned means `ok`. Throwing is a failure, with backoff. `after`
 * runs once the run's transaction has committed and never otherwise, for what
 * must not happen ahead of the commit, such as a Queue send for a row the run
 * wrote. If it throws the run still stands; the error is logged.
 */
export type Handler = (run: JobRun) => Promise<
  | {
      outcome: "ok" | "skipped"
      detail?: string
      after?: () => Promise<void>
    }
  | undefined
>

export type Handlers = Partial<Record<ScheduledJob["kind"], Handler>>

/** The `jobs` Queue's name in each environment, as the wrangler config spells it. */
export const JOBS_QUEUES = ["reme-jobs", "reme-jobs-production"]

/** One handler per kind, added by the story that adds the kind. */
export const HANDLERS: Handlers = { reminder: reminderJob }

/** Failures in a row before a job pauses and the owner is told. */
export const MAX_FAILURES = 5

/** Minutes to wait after the `failures`th failure in a row. */
export const backoffMinutes = (failures: number) => Math.min(60, 2 ** failures)

export const PAUSED_TEXT =
  "Something I was meant to do on a schedule kept failing, so I've paused it. I'll tell you more when I can."

/**
 * What became of a message: the run's outcome; `paused` for the failure that
 * paused it; `closed` when its org was closed; `stale` when there was nothing
 * to run, which is how a redelivered message ends.
 */
export type Ran = "ok" | "skipped" | "failed" | "paused" | "closed" | "stale"

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
 * Runs one claimed job once. The `job_runs` row for this occurrence goes in
 * first, and a conflict on it means the occurrence already ran. Success moves
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
  let after: (() => Promise<void>) | undefined
  try {
    const ran = await kit.withOrg({ orgId }, async (db): Promise<Ran> => {
      after = undefined
      const job = await claimedJob(db, jobId, now)
      if (!job) return "stale"
      if (!(await orgOpen(db))) {
        await db
          .update(scheduledJobs)
          .set({ pausedAt: now, claimedAt: null })
          .where(eq(scheduledJobs.id, jobId))
        return "closed"
      }
      const [run] = await db
        .insert(jobRuns)
        .values({ jobId, orgId, runAt: job.nextRunAt, outcome: "ok" })
        .onConflictDoNothing()
        .returning({ jobId: jobRuns.jobId })
      if (!run) return "stale"
      const handler = handlers[job.kind]
      const result: Awaited<ReturnType<Handler>> = handler
        ? await handler({ db, env, job, now })
        : { outcome: "skipped", detail: "no handler" }
      after = result?.after
      if (result)
        await db
          .update(jobRuns)
          .set({ outcome: result.outcome, detail: result.detail ?? null })
          .where(
            sql`${eq(jobRuns.jobId, jobId)} and ${eq(jobRuns.runAt, job.nextRunAt)}`
          )
      if (job.rule) {
        const [org] = await db.select({ zone: orgs.timeZone }).from(orgs)
        next = nextRun(job.rule, org?.zone ?? null, now)
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
      return result?.outcome ?? "ok"
    })
    if (next) await lowerNextDue(env.SCHEDULE, next)
    // Committed. A failure here leaves the handler's delivery rows pending.
    await after?.().catch((error: unknown) =>
      console.error(
        JSON.stringify({
          code: "jobs.after_failed",
          job_id: jobId,
          error: failureCode(error),
        })
      )
    )
    return ran
  } catch (error) {
    return failed(kit, env, { jobId, orgId }, error, now)
  }
}

/**
 * The run threw and its transaction rolled back. Record the failure in a
 * transaction of its own and back off; the fifth in a row pauses the job and
 * tells the owner. If this throws too, the message is retried.
 */
async function failed(
  kit: Tenancy,
  env: Env,
  { jobId, orgId }: JobMessage,
  error: unknown,
  now: Date
): Promise<Ran> {
  const code = failureCode(error)
  console.error(
    JSON.stringify({ code: "jobs.run_failed", job_id: jobId, error: code })
  )
  const after = await kit.withOrg({ orgId }, async (db) => {
    const job = await claimedJob(db, jobId, now)
    if (!job) return null
    const [run] = await db
      .insert(jobRuns)
      .values({
        jobId,
        orgId,
        runAt: job.nextRunAt,
        outcome: "failed",
        detail: code,
      })
      .onConflictDoNothing()
      .returning({ jobId: jobRuns.jobId })
    if (!run) return null
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
    return { next, paused }
  })
  if (!after) return "stale"
  if (!after.paused) {
    await lowerNextDue(env.SCHEDULE, after.next)
    return "failed"
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
 * the cron retakes the job either way.
 */
export async function jobsBatch(
  batch: MessageBatch<JobMessage>,
  env: Env
): Promise<void> {
  await withKit(env, async (kit) => {
    for (const message of batch.messages) {
      try {
        const ran = await runJob(kit, env, message.body)
        console.log(
          JSON.stringify({ type: "jobs.ran", job_id: message.body.jobId, ran })
        )
        message.ack()
      } catch (error) {
        console.error(
          JSON.stringify({
            code: "jobs.unrecorded",
            job_id: message.body.jobId,
            error: failureCode(error),
          })
        )
        message.retry()
      }
    }
  })
}
