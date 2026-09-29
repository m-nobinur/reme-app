import { failure } from "./http.ts"

/**
 * How many writes one signed-in person may make a minute, the chat turn
 * among them. Model spend has a daily cap per org; this is the per-minute
 * bound under it, so a script replaying a session spends a minute's worth
 * before it is refused rather than a day's.
 *
 * Thirty, because honest use stays well under it. The golden path's
 * busiest minute is onboarding: the signup write, five answers as fast as
 * a script can save them, each a chat turn and at most a fact write, and
 * the build it approves, twelve at most. A chat turn streams for seconds
 * before the next can be sent. A person clicking Done down a list of
 * reminders at one every two seconds reaches thirty.
 *
 * The count is Cloudflare's `ratelimit` binding: per location and
 * best-effort, which with this worker's placement in `aws:eu-central-1` is
 * close to one counter. `wrangler.jsonc` declares it in both blocks, and
 * `limit.test.ts` reads that file so the numbers here and there agree.
 */
export const WRITES_PER_MINUTE = 30
export const WRITE_WINDOW_SECONDS = 60

/** The binding, narrowed to the one method this calls. */
export type Limiter = {
  limit: (options: { key: string }) => Promise<{ success: boolean }>
}

/**
 * The 429 for a person over their minute, or null to let the write through.
 * Keyed on the WorkOS user, so it runs before the org is resolved and costs
 * no database round trip. With no binding the write goes through: a worker
 * deployed without one is caught by `limit.test.ts`, not at runtime.
 */
export async function limitWrites(
  limiter: Limiter | undefined,
  workosUserId: string
): Promise<Response | null> {
  if (!limiter) return null
  const { success } = await limiter.limit({ key: `writes:${workosUserId}` })
  if (success) return null
  const response = failure(429, {
    class: "transient",
    code: "rate.limited",
    message: "Too many changes in a short time. Wait a minute and try again.",
    detail: {
      limit: WRITES_PER_MINUTE,
      period_seconds: WRITE_WINDOW_SECONDS,
    },
  })
  response.headers.set("retry-after", String(WRITE_WINDOW_SECONDS))
  return response
}
