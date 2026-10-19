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
 * Sets the stored earliest due time to `at` when `at` is sooner. Call it
 * after the commit that wrote the job. It never throws: two writers can race
 * on the key and KV is eventually consistent, so a lost write here only
 * delays the job to the cron's next fallback scan, which the job's own row
 * guarantees. No stored value means the next minute scans anyway.
 */
export async function lowerNextDue(kv: DueStore, at: Date): Promise<void> {
  try {
    const stored = await readNextDue(kv)
    if (!stored || (stored.next !== null && stored.next <= at.getTime())) return
    await kv.put(
      NEXT_DUE_KEY,
      JSON.stringify({ ...stored, next: at.getTime() } satisfies NextDue)
    )
  } catch (error) {
    console.error(
      JSON.stringify({
        code: "jobs.next_due_unwritten",
        error: error instanceof Error ? error.name : "unknown",
      })
    )
  }
}
