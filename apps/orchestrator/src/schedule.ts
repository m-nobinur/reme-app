import {
  claimDueJobs,
  NEXT_DUE_KEY,
  type NextDue,
  nextDueAt,
  readNextDue,
} from "@workspace/db"
import { Cron } from "croner"
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
  now = Date.now()
): Promise<number | null> {
  // An unreadable value counts as stale: the scan is the safe side.
  const stored = await readNextDue(env.SCHEDULE).catch(() => null)
  if (
    stored &&
    (stored.next === null || stored.next > now) &&
    now - stored.scanned < FALLBACK_MS
  )
    return null
  return withKit(env, async (kit) => {
    // A claim whose send fails is retaken when its lease runs out.
    const claimed = await claimDueJobs(kit, CLAIM_BATCH)
    if (claimed.length > 0)
      await env.JOBS.sendBatch(
        claimed.map((body): { body: JobMessage } => ({ body }))
      )
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

/**
 * The first time strictly after `after` that `rule`, a five-part cron
 * expression, matches in `zone` (UTC when null). Across a DST change croner
 * keeps wall-clock meaning: a time that happens twice fires at the first, and
 * a time the clocks skip fires an hour later (02:30 becomes 03:30).
 */
export function nextRun(rule: string, zone: string | null, after: Date): Date {
  const next = new Cron(rule, {
    timezone: zone ?? "UTC",
    mode: "5-part",
  }).nextRun(after)
  if (!next) throw new Error("jobs.rule_never_matches")
  return next
}
