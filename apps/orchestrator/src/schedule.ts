import {
  claimDueJobs,
  eq,
  NEXT_DUE_KEY,
  type NextDue,
  nextDueAt,
  readNextDue,
  type ScanMessage,
  scheduledJobs,
} from "@workspace/db"
import { withKit } from "./domain-flow.ts"

/**
 * The scheduler's cron (ADR-043). Matched character for character against
 * the wrangler config, in both environments.
 */
export const SCHEDULE_CRON = "* * * * *"

/**
 * How old the last Postgres scan may get before the cron scans whatever KV
 * says. KV only ever holds a time later than the truth when a write was lost
 * or has not propagated yet, and the scan finds the job from its own row, so
 * such a job is delayed to the next fallback scan, never lost. Under an hour
 * so Neon still sleeps between scans on a quiet day.
 */
export const FALLBACK_MS = 55 * 60_000

/** One claim per minute, and the most one `sendBatch` takes. */
export const CLAIM_BATCH = 100

/** One claimed job, which is all a Queue message carries. */
export type JobMessage = { jobId: string; orgId: string }

export type RedriveMessage = { kind: "redrive"; orgId: string }

/** What `reme-jobs` carries: a claimed job, a wake asking for a scan, or a redrive. */
export type JobsQueueMessage = JobMessage | ScanMessage | RedriveMessage

/** When a build whose start failed is redriven, ahead of the hourly sweep. */
export const REDRIVE_DELAYS_S = [60, 180, 600]

type ScheduleEnv = Pick<Env, "HYPERDRIVE" | "SCHEDULE" | "JOBS">

/**
 * The minute's work: nothing at all unless KV says a job is due or the last
 * scan is old; otherwise claim the due jobs, send one message each, and write
 * the new earliest time back. Returns how many were claimed, or null when
 * Postgres was not touched.
 *
 * shortcut: one claim of 100 a minute; when a burst of due jobs passes that,
 * the rest wait a minute each, so loop the claim then.
 */
export async function scanDue(
  env: ScheduleEnv,
  now = Date.now(),
  /** A wake's scan (`ScanMessage`), which KV must not talk out of it. */
  force = false
): Promise<number | null> {
  // An unreadable value counts as stale: the scan is the safe side.
  const stored = await readNextDue(env.SCHEDULE).catch(() => null)
  if (
    !force &&
    stored &&
    (stored.next === null || stored.next > now) &&
    now - stored.scanned < FALLBACK_MS
  )
    return null
  return withKit(env, async (kit) => {
    const claimed = await claimDueJobs(kit, CLAIM_BATCH)
    if (claimed.length > 0) {
      try {
        await env.JOBS.sendBatch(
          claimed.map((body): { body: JobMessage } => ({ body }))
        )
      } catch (error) {
        // Unsent, so give the claims back: the next minute retakes them,
        // rather than the lease 20 minutes on. KV is left as it was, due.
        for (const { jobId, orgId } of claimed)
          await kit.withOrg({ orgId }, (db) =>
            db
              .update(scheduledJobs)
              .set({ claimedAt: null })
              .where(eq(scheduledJobs.id, jobId))
          )
        throw error
      }
    }
    const next = (await nextDueAt(kit))?.getTime() ?? null
    await env.SCHEDULE.put(
      NEXT_DUE_KEY,
      JSON.stringify({ next, scanned: now } satisfies NextDue)
    )
    console.log(
      JSON.stringify({ type: "jobs.scanned", claimed: claimed.length, next })
    )
    return claimed.length
  })
}
