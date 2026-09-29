import type { AuthFailure } from "./failure"

/**
 * A limit on how often one address may be offered a password, sign up, or ask
 * for a reset email, and how often one reset link may be tried.
 *
 * There was none before this. `failure.ts` turns WorkOS's own 429 into a
 * message, which is WorkOS rate-limiting us across the whole environment and
 * says nothing about one account being guessed at.
 *
 * The counting is Cloudflare's `ratelimit` binding, which is the platform
 * feature for this and has been GA since 2025-09-19. It is per-colo and
 * best-effort by design: an attacker spread across regions gets a multiple of
 * the number below rather than exactly it. That is the trade the binding makes
 * to cost nothing, and it is the right trade here, because the alternative that
 * counts exactly is a Durable Object per address and a round trip on every
 * sign-in.
 *
 * Keyed on the address and not the IP. The threat a sign-in form has is someone
 * working through passwords for one account, and an IP key catches an office
 * behind one NAT before it catches them. Spreading one attempt each across many
 * addresses walks through this untouched; that is credential stuffing, it is
 * answered at the edge rather than in a Worker, and it is written down as
 * unaddressed rather than implied to be covered.
 */
export const SIGN_IN_ATTEMPTS = 5
export const SIGN_IN_WINDOW_SECONDS = 60

/** What the binding gives us, narrowed to the one method we call. */
export type Limiter = {
  limit: (options: { key: string }) => Promise<{ success: boolean }>
}

/**
 * The forms that are counted, each in its own buckets on the one binding, so a
 * person who asked for three reset emails still has five sign-ins left. What
 * each is keyed on: the address, except `reset`, which has none and is keyed
 * on its link's token.
 */
export type Throttled = "sign-in" | "sign-up" | "reset-request" | "reset"

const REFUSED: Record<Throttled, string> = {
  "sign-in": "Too many sign-in attempts for that email.",
  "sign-up": "Too many sign-up attempts for that email.",
  "reset-request": "Too many reset emails asked for that address.",
  reset: "Too many attempts with this reset link.",
}

/**
 * One bucket per form and address, case-folded and trimmed.
 *
 * WorkOS lowercases on store, so `Dana@` and `dana@` are the same account and
 * have to be the same bucket; without the fold, changing one letter's case is
 * a free reset. An empty address gets the empty bucket rather than a pass:
 * every blank submission then shares one counter, which limits more, not less.
 * Folding a reset token can only merge two links' buckets, which also limits
 * more.
 */
export function throttleKey(form: Throttled, value: string): string {
  return `${form}:${value.trim().toLowerCase()}`
}

/**
 * The failure to show, or `null` to let the attempt through.
 *
 * The limiter is a parameter rather than an import so this file never reaches
 * for `cloudflare:workers`, which no test can resolve and no client bundle
 * should carry. `actions.ts` reads the binding and hands it over.
 *
 * With no binding the attempt goes through. That is a hole, and the thing that
 * closes it is not a runtime check but `throttle.test.ts`, which reads
 * `wrangler.jsonc` and fails if the binding is not declared: a Worker deployed
 * without a limiter is caught before it is deployed rather than after. Failing
 * closed instead would mean an unconfigured environment locks everybody out of
 * an app whose only way in is this form.
 */
export async function throttle(
  limiter: Limiter | undefined,
  form: Throttled,
  value: string
): Promise<AuthFailure | null> {
  if (!limiter) {
    return null
  }
  const { success } = await limiter.limit({ key: throttleKey(form, value) })
  if (success) {
    return null
  }
  // The same shape `failure.ts` gives WorkOS's own 429, so the page renders it
  // through the branch it already has and no route changes.
  return {
    code: "rate_limited",
    message: `${REFUSED[form]} Try again in ${SIGN_IN_WINDOW_SECONDS} seconds.`,
    retryAfter: SIGN_IN_WINDOW_SECONDS,
  }
}
