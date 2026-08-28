import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  type Limiter,
  SIGN_IN_ATTEMPTS,
  SIGN_IN_WINDOW_SECONDS,
  signInKey,
  throttleSignIn,
} from "./throttle"

/**
 * The limit on the sign-in form: that it trips, that it does not trip on
 * somebody signing in, and that the Worker is configured to have one at all.
 *
 * The counting itself belongs to Cloudflare and is not re-tested here. What is
 * ours is the key, the decision, and the configuration, and a stand-in counter
 * exercises all three without needing workerd.
 */

/** A counter that behaves like the binding: N per key, then refusals. */
function counter(limit: number): Limiter & { calls: string[] } {
  const seen = new Map<string, number>()
  const calls: string[] = []
  return {
    calls,
    limit: async ({ key }) => {
      calls.push(key)
      const next = (seen.get(key) ?? 0) + 1
      seen.set(key, next)
      return { success: next <= limit }
    },
  }
}

describe("the key one address is counted under", () => {
  it("is the same bucket however the address is cased or padded", () => {
    // WorkOS folds case on store, so these are one account. A key that did not
    // fold would make changing one letter's case a free reset of the counter.
    const keys = new Set(
      [
        "dana@brightclean.invalid",
        "Dana@Brightclean.Invalid",
        "  dana@brightclean.invalid  ",
      ].map(signInKey)
    )
    expect(keys.size).toBe(1)
  })

  it("is a different bucket for a different address", () => {
    expect(signInKey("dana@brightclean.invalid")).not.toBe(
      signInKey("kit@mopandbucket.invalid")
    )
  })

  it("puts blank submissions in one bucket rather than none", () => {
    // Not a pass. Every empty form shares a counter, which limits more.
    expect(signInKey("")).toBe(signInKey("   "))
    expect(signInKey("")).toBeTruthy()
  })
})

describe("the limit trips", () => {
  it("lets the configured number through and refuses the next", async () => {
    const limiter = counter(SIGN_IN_ATTEMPTS)
    const email = "dana@brightclean.invalid"

    for (let attempt = 1; attempt <= SIGN_IN_ATTEMPTS; attempt += 1) {
      expect(
        await throttleSignIn(limiter, email),
        `attempt ${attempt} was refused`
      ).toBeNull()
    }

    const refused = await throttleSignIn(limiter, email)
    expect(refused).not.toBeNull()
    expect(refused?.code).toBe("rate_limited")
    // Rendered as a form-level message by sign-in.tsx, which shows a failure
    // with no `field` in the Alert it already has.
    expect(refused?.field).toBeUndefined()
    expect(refused?.retryAfter).toBe(SIGN_IN_WINDOW_SECONDS)
    // The message says what to do, and does not repeat the address back into a
    // page that may be screenshotted (the rule failure.ts follows).
    expect(refused?.message).not.toContain(email)
  })

  it("refuses before the password reaches WorkOS", async () => {
    // The point of limiting: a guess that is refused here costs one counter
    // increment, not an authentication call. `signIn` returns on a non-null
    // failure, so the assertion that matters is that this answers without
    // needing anything but the limiter.
    const limiter = counter(0)
    const refused = await throttleSignIn(limiter, "dana@brightclean.invalid")
    expect(refused?.code).toBe("rate_limited")
    expect(limiter.calls).toHaveLength(1)
  })
})

describe("a legitimate person is not caught", () => {
  it("lets someone mistype their password and get it right", async () => {
    // Four wrong then one right, which is a normal bad morning and has to work.
    const limiter = counter(SIGN_IN_ATTEMPTS)
    const email = "kit@mopandbucket.invalid"
    for (let attempt = 1; attempt <= SIGN_IN_ATTEMPTS; attempt += 1) {
      expect(await throttleSignIn(limiter, email)).toBeNull()
    }
  })

  it("does not spend one person's budget on another's", async () => {
    // The failure an IP key has and this one does not: an office behind one
    // address, everybody signing in at nine o'clock.
    const limiter = counter(SIGN_IN_ATTEMPTS)
    const office = Array.from(
      { length: 20 },
      (_, i) => `person${i}@brightclean.invalid`
    )
    for (const email of office) {
      expect(await throttleSignIn(limiter, email), email).toBeNull()
    }
  })

  it("gives the address its budget back in the next window", async () => {
    // The stand-in counts forever, so a fresh one is what a new window looks
    // like. Enough to pin that nothing else in this file holds state.
    const email = "dana@brightclean.invalid"
    const first = counter(SIGN_IN_ATTEMPTS)
    for (let attempt = 1; attempt <= SIGN_IN_ATTEMPTS; attempt += 1) {
      await throttleSignIn(first, email)
    }
    expect(await throttleSignIn(first, email)).not.toBeNull()
    expect(await throttleSignIn(counter(SIGN_IN_ATTEMPTS), email)).toBeNull()
  })
})

describe("the Worker is configured to have a limiter", () => {
  /**
   * `throttleSignIn` lets the attempt through when the binding is absent,
   * because failing closed would lock everyone out of an app whose only door is
   * this form. That is only safe if a Worker cannot be deployed without the
   * binding, and this is what makes it so.
   */
  const config = JSON.parse(
    readFileSync(
      fileURLToPath(new URL("../../../wrangler.jsonc", import.meta.url)),
      "utf8"
      // The file is jsonc. Only `//` line comments are used in it, and a `//`
      // inside a string would be a URL, of which it has none.
    ).replace(/^\s*\/\/.*$/gm, "")
  ) as {
    ratelimits?: Array<{
      name: string
      namespace_id: string
      simple: { limit: number; period: number }
    }>
  }

  it("declares the binding the sign-in handler reads", () => {
    const binding = config.ratelimits?.find(
      (entry) => entry.name === "SIGN_IN_LIMIT"
    )
    expect(
      binding,
      "apps/web/wrangler.jsonc has no SIGN_IN_LIMIT ratelimit binding, so the deployed sign-in form has no limit"
    ).toBeDefined()
    expect(binding?.namespace_id).toMatch(/^[1-9]\d*$/)
  })

  it("configures it with the numbers this module reasons about", () => {
    // Two copies of a number drift, and the copy that drifts is the one nobody
    // reads. Cloudflare accepts only 10 or 60 for the period, so the window is
    // not free to be anything.
    const binding = config.ratelimits?.find(
      (entry) => entry.name === "SIGN_IN_LIMIT"
    )
    expect(binding?.simple.limit).toBe(SIGN_IN_ATTEMPTS)
    expect(binding?.simple.period).toBe(SIGN_IN_WINDOW_SECONDS)
    expect([10, 60]).toContain(binding?.simple.period)
  })
})
