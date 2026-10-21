/**
 * The scheduler's KV guard (ADR-043). The orchestrator's per-minute cron reads
 * this key and queries Postgres only when a job is due or its last scan is
 * old, so a quiet minute costs one KV read and Neon stays asleep. The cron
 * writes it after each scan from `next_due_at()`; anything that creates a job
 * or moves one earlier lowers it with `lowerNextDue`.
 */
export const NEXT_DUE_KEY = "jobs:next-due"

/** Epoch milliseconds: the earliest due time (null for none) and the last scan. */
export type NextDue = { next: number | null; scanned: number }

/** The two calls the guard makes, which a `KVNamespace` binding has. */
export type DueStore = {
  get: (key: string, type: "json") => Promise<unknown>
  put: (key: string, value: string) => Promise<void>
}

export async function readNextDue(kv: DueStore): Promise<NextDue | null> {
  const value = (await kv.get(NEXT_DUE_KEY, "json")) as Partial<NextDue> | null
  return value &&
    typeof value.scanned === "number" &&
    (value.next === null || typeof value.next === "number")
    ? { next: value.next, scanned: value.scanned }
    : null
}

/**
 * A Queue message that asks the jobs consumer to scan now, whatever KV says.
 * It names no job, so a duplicate or a stale one costs one claim and no more.
 */
export type ScanMessage = { kind: "scan" }

/** The one call the wake makes, which a `Queue` producer binding has. */
export type WakeQueue = {
  send: (
    body: ScanMessage,
    options: { delaySeconds: number }
  ) => Promise<unknown>
}

/** A Queue message's longest delay, 12 hours. Later jobs wait for the cron. */
export const WAKE_DELAY_MAX_S = 12 * 60 * 60

const failed = (code: string, error: unknown) =>
  console.error(
    JSON.stringify({
      code,
      error: error instanceof Error ? error.name : "unknown",
    })
  )

/**
 * Sets the stored earliest due time to `at` when `at` is sooner, and with a
 * `wake` queue also sends a scan timed for `at`. Call it after the commit that
 * wrote the job. It never throws: two writers can race on the key and KV is
 * eventually consistent, so a lost write here only delays the job to the
 * cron's next fallback scan, which the job's own row guarantees. No stored
 * value means the next minute scans anyway.
 *
 * The wake is what makes a job run on time. A KV write can take a minute to
 * reach the location the cron runs in, and the cron's read is cached for
 * another, so on KV alone a reminder came 2.5 minutes late on staging.
 */
export async function lowerNextDue(
  kv: DueStore,
  at: Date,
  wake?: WakeQueue
): Promise<void> {
  try {
    const stored = await readNextDue(kv)
    if (stored && (stored.next === null || stored.next > at.getTime()))
      await kv.put(
        NEXT_DUE_KEY,
        JSON.stringify({ ...stored, next: at.getTime() } satisfies NextDue)
      )
  } catch (error) {
    failed("jobs.next_due_unwritten", error)
  }
  if (!wake) return
  // A second over, so the scan never lands before the job is due.
  const seconds = Math.ceil((at.getTime() - Date.now()) / 1000) + 1
  if (seconds > WAKE_DELAY_MAX_S) return
  try {
    await wake.send({ kind: "scan" }, { delaySeconds: Math.max(0, seconds) })
  } catch (error) {
    failed("jobs.wake_unsent", error)
  }
}
