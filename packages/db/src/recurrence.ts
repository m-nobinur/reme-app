import { Cron } from "croner"
import { eq, sql } from "drizzle-orm"
import { scheduledJobs } from "./schema.ts"
import type { OrgScopedDb } from "./tenancy.ts"

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

/**
 * Moves the org's recurring jobs to their rule's next time in `zone`, for
 * when `orgs.time_zone` changes; call it in the same transaction. A job that
 * is already due, claimed or paused is left alone: a due one runs and then
 * reads the new zone itself. Returns the earliest new time, for
 * `lowerNextDue` after the commit.
 */
export async function recomputeOrgJobs(
  db: OrgScopedDb,
  zone: string | null,
  now = new Date()
): Promise<Date | null> {
  const jobs = await db
    .select({ id: scheduledJobs.id, rule: scheduledJobs.rule })
    .from(scheduledJobs)
    .where(
      sql`${scheduledJobs.rule} is not null and ${scheduledJobs.pausedAt} is null and ${scheduledJobs.claimedAt} is null and ${scheduledJobs.nextRunAt} > ${now.toISOString()}::timestamptz`
    )
  let earliest: Date | null = null
  for (const job of jobs) {
    const next = nextRun(job.rule as string, zone, now)
    await db
      .update(scheduledJobs)
      .set({ nextRunAt: next })
      .where(eq(scheduledJobs.id, job.id))
    if (!earliest || next < earliest) earliest = next
  }
  return earliest
}
