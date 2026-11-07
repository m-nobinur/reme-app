import { describe, expect, it } from "vitest"
import { OPENROUTER_IDS } from "../src/models/index.ts"
import { completeOnce } from "../src/once.ts"

/**
 * Every model the app can route reads its own prompt cache through
 * `completeOnce`. A model has to be in the generated table to be routed, so
 * a new or swapped model lands here without an edit. The same prefix goes
 * out up to three times and one of the later calls must read at least half
 * of it from the cache. A model that needs a parameter we do not send fails
 * here instead of on the bill. Skipped without a key; costs a few cents.
 */
const env = { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY }
const live = describe.skipIf(!env.OPENROUTER_API_KEY)

/** Read nothing without a marker (measured 2026-11-06), and pi-ai marks only Claude. The api marks the chat's instructions for it. */
const MARKER_ONLY = new Set(["google/gemini-3.8-flash"])

const nonce = `${Date.now()}`
const system = `[${nonce}] You are terse. House rules:\n${Array.from(
  { length: 140 },
  (_, i) => `Rule ${i + 1}: answer in one short sentence.`
).join("\n")}`

live("every routed model reads its cache", { timeout: 180_000 }, () => {
  for (const id of OPENROUTER_IDS) {
    const model = `openrouter/${id}`
    const check = MARKER_ONLY.has(id) ? it.fails : it
    check(model, async () => {
      let share = 0
      for (let call = 0; call < 3 && share < 0.5; call++) {
        const reply = await completeOnce(env, {
          model,
          effort: "low",
          maxTokens: 1_000,
          system: `${system} (${model})`,
          user: "Say ok.",
          sessionId: `cache-guard-${nonce}-${model}`,
        })
        const { input, cacheRead, cacheWrite } = reply.usage
        share = cacheRead / (input + cacheRead + cacheWrite)
        await new Promise((resolve) => setTimeout(resolve, 3_000))
      }
      expect(share).toBeGreaterThanOrEqual(0.5)
    })
  }
})
