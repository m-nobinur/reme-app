import type { MemoryInput, ProfileLine } from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import fixture from "../../../evals/fixtures/reflection-sessions.json" with {
  type: "json",
}
import { DEFAULT_MODEL, openrouterModel, priceOf } from "../src/cos/agent.ts"
import { type Layer, layerOf, refusalOf } from "../src/cos/memory.ts"
import {
  REFLECTION,
  reviewBatch,
  reviewMessages,
  runReview,
  verdictOf,
  windowOf,
} from "../src/cos/reflection.ts"

/**
 * Live: the review (ADR-042) over the twenty sessions with the real model
 * the CoS runs on. Each session the cadence would run goes through the same
 * messages, prefix and guards as the job, against an in-memory profile its
 * session starts from. It passes when no line the guards let through reads
 * as an instruction, and prints every batch the model made, what the guards
 * refused and why, what each review cost and its cache share. It spends
 * money, so it runs only with `REFLECTION_LIVE=1` and `OPENROUTER_API_KEY`.
 */

const KEY = process.env.OPENROUTER_API_KEY ?? ""
const LIVE = process.env.REFLECTION_LIVE === "1" && KEY !== ""
const AT = "2026-10-21T10:00:00.000Z"

describe.skipIf(!LIVE)("the review with the real model", () => {
  it("writes no instruction-shaped line", async () => {
    const model = openrouterModel(KEY, DEFAULT_MODEL)
    const price = priceOf(DEFAULT_MODEL)
    if (!model || !price) throw new Error(`no route for ${DEFAULT_MODEL}`)
    let cost = 0
    let calls = 0
    const written: string[] = []
    const shaped: string[] = []
    for (const [n, session] of fixture.sessions.entries()) {
      let lines: ProfileLine[] = (session.held ?? []).map((h, i) => ({
        id: `00000000-0000-4000-8000-${String(n * 100 + i).padStart(12, "0")}`,
        text: h.text,
        source: h.source as ProfileLine["source"],
        at: AT,
      }))
      const rows = session.turns.flatMap((t, i) => [
        {
          seq: i * 2,
          type: "cos.message",
          payload: {
            message: {
              id: `u${i}`,
              role: "user",
              parts: [{ type: "text", text: t.owner }],
            },
          },
        },
        {
          seq: i * 2 + 1,
          type: "cos.message",
          payload: {
            message: {
              id: `a${i}`,
              role: "assistant",
              parts: [{ type: "text", text: t.cos }],
            },
          },
        },
      ])
      const window = windowOf(rows as never, -1)
      if (verdictOf(window, session.idle) !== "run") {
        console.log(
          `      ${session.id}: no call (${verdictOf(window, session.idle)})`
        )
        continue
      }
      const cap = Math.max(1, Math.floor(lines.length * REFLECTION.share))
      let used = 0
      const log: unknown[] = []
      const made = await runReview(
        { model, modelId: DEFAULT_MODEL, price },
        reviewMessages(window, [{ layer: layerOf("user") as Layer, lines }]),
        {
          memory: async (raw) => {
            const input = raw as MemoryInput
            for (const op of input.operations) {
              if (op.content && refusalOf(op.content)) shaped.push(op.content)
            }
            if (input.target !== "user") return { outcome: "refused" }
            const done = reviewBatch(
              lines,
              input.operations,
              window.owner,
              cap - used,
              1_500
            )
            log.push([input.operations, done.ok || Object.keys(done)[1]])
            if (!done.ok) return done
            used += input.operations.length
            lines = done.lines
            return { outcome: "saved" }
          },
        }
      )
      calls += 1
      cost += made.cost
      written.push(...lines.map((l) => l.text))
      const share = made.usage
        ? made.usage.cached_input_tokens / Math.max(1, made.usage.input_tokens)
        : null
      console.log(
        `      ${session.id}: ${JSON.stringify(log)}${made.problem ? `, problem ${made.problem}` : ""}, $${made.cost.toFixed(5)}, cache ${share}, ${made.ms} ms`
      )
    }
    console.log(
      `      ${calls} reviews, $${cost.toFixed(5)} in all; instruction-shaped lines proposed: ${JSON.stringify(shaped)}`
    )
    expect(calls).toBeGreaterThan(10)
    expect(written.filter((t) => refusalOf(t) !== null)).toEqual([])
  }, 600_000)
})
