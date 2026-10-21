import { Cron } from "croner"
import { eq, sql } from "drizzle-orm"
import { orgs, scheduledJobs } from "./schema.ts"
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

/** Quiet hours as `HH:MM` wall-clock times; start after end crosses midnight, equal means none. */
export type Quiet = { start: string; end: string }

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/** Whether `at` falls in the quiet hours in `zone` (UTC when null), start included, end not. */
export function inQuiet(at: Date, zone: string | null, quiet: Quiet): boolean {
  const start = minutes(quiet.start)
  const end = minutes(quiet.end)
  const now = minutes(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone ?? "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(at)
  )
  return start < end
    ? now >= start && now < end
    : start > end && (now >= start || now < end)
}

/** `at`, or the end of the quiet hours it falls in, read as wall-clock time in `zone`. */
export function afterQuiet(at: Date, zone: string | null, quiet: Quiet): Date {
  if (!inQuiet(at, zone, quiet)) return at
  const [h, m] = quiet.end.split(":").map(Number)
  return nextRun(`${m} ${h} * * *`, zone, at)
}

/** How often the heartbeat looks at each proactivity level; `off` has no job. */
export const HEARTBEAT_RULES = {
  low: "0 */8 * * *",
  default: "0 */4 * * *",
  high: "0 * * * *",
} as const

/** The `orgs` columns a recurring job's next time depends on. */
export type OrgClock = {
  timeZone: string | null
  quietStart: string
  quietEnd: string
}

/**
 * A recurring job's next time after `after`. A heartbeat that would land in
 * quiet hours waits for their end; nothing else looks at them, since a
 * reminder's time is the owner's own.
 */
export function nextFor(
  job: { kind: string; rule: string },
  org: OrgClock,
  after: Date
): Date {
  const next = nextRun(job.rule, org.timeZone, after)
  return job.kind === "heartbeat"
    ? afterQuiet(next, org.timeZone, {
        start: org.quietStart,
        end: org.quietEnd,
      })
    : next
}

/**
 * Gives the org the one heartbeat job its proactivity asks for: none when
 * `off`, otherwise one on that level's rule. Safe to repeat, so signup and
 * the hourly sweep both call it, and so does whatever changes the dial; a job
 * already on the right rule is left as it is. The org row is locked so two
 * callers cannot both insert. Returns a new `next_run_at`, for
 * `lowerNextDue` after the commit.
 */
export async function ensureHeartbeat(
  db: OrgScopedDb,
  now = new Date()
): Promise<Date | null> {
  const [org] = await db
    .select({
      id: orgs.id,
      proactivity: orgs.proactivity,
      timeZone: orgs.timeZone,
      quietStart: orgs.quietStart,
      quietEnd: orgs.quietEnd,
    })
    .from(orgs)
    .for("update")
  if (!org) return null
  const heartbeat = sql`${scheduledJobs.kind} = 'heartbeat'`
  const [job] = await db
    .select({ rule: scheduledJobs.rule })
    .from(scheduledJobs)
    .where(heartbeat)
  if (org.proactivity === "off") {
    if (job) await db.delete(scheduledJobs).where(heartbeat)
    return null
  }
  const rule = HEARTBEAT_RULES[org.proactivity]
  if (job?.rule === rule) return null
  const nextRunAt = nextFor({ kind: "heartbeat", rule }, org, now)
  // A claim in flight finds itself cleared and stops, rather than running on the old rule.
  if (job)
    await db
      .update(scheduledJobs)
      .set({ rule, nextRunAt, claimedAt: null, failures: 0, pausedAt: null })
      .where(heartbeat)
  else
    await db
      .insert(scheduledJobs)
      .values({ orgId: org.id, kind: "heartbeat", rule, nextRunAt })
  return nextRunAt
}

/**
 * Moves the org's recurring jobs to their next time in `zone`, for when
 * `orgs.time_zone` or the quiet hours change; call it in the same
 * transaction, after the change. A job that is already due, claimed or
 * paused is left alone: a due one runs and then reads the new values itself.
 * Returns the earliest new time, for `lowerNextDue` after the commit.
 */
export async function recomputeOrgJobs(
  db: OrgScopedDb,
  zone: string | null,
  now = new Date()
): Promise<Date | null> {
  const [org] = await db
    .select({ quietStart: orgs.quietStart, quietEnd: orgs.quietEnd })
    .from(orgs)
  const jobs = await db
    .select({
      id: scheduledJobs.id,
      kind: scheduledJobs.kind,
      rule: scheduledJobs.rule,
    })
    .from(scheduledJobs)
    .where(
      sql`${scheduledJobs.rule} is not null and ${scheduledJobs.pausedAt} is null and ${scheduledJobs.claimedAt} is null and ${scheduledJobs.nextRunAt} > ${now.toISOString()}::timestamptz`
    )
  let earliest: Date | null = null
  for (const job of jobs) {
    const next = nextFor(
      { kind: job.kind, rule: job.rule as string },
      {
        timeZone: zone,
        quietStart: org?.quietStart ?? "21:00",
        quietEnd: org?.quietEnd ?? "08:00",
      },
      now
    )
    await db
      .update(scheduledJobs)
      .set({ nextRunAt: next })
      .where(eq(scheduledJobs.id, job.id))
    if (!earliest || next < earliest) earliest = next
  }
  return earliest
}
