import { describe, expect, it } from "vitest"
import fixture from "../../../evals/fixtures/reflection-sessions.json" with {
  type: "json",
}
import { openrouterModel } from "../src/cos/agent.ts"
import { refusalOf } from "../src/cos/memory.ts"
import {
  guard,
  promptOf,
  REFLECTION,
  reflect,
  verdictOf,
  windowOf,
} from "../src/cos/reflection.ts"

/**
 * Live: reflection (ADR-042) over the twenty sessions with the real model.
 * Each session the cadence would run goes through the same prompt, answer
 * parser and guards as the job; the held profile each session starts from is
 * its own. It passes when no line the guards let through reads as an
 * instruction, and prints every line the model proposed that the guards
 * dropped, with why, and what the run cost. It spends money, so it runs only
 * with `REFLECTION_LIVE=1` and `OPENROUTER_API_KEY`.
 */

const KEY = process.env.OPENROUTER_API_KEY ?? ""
const LIVE = process.env.REFLECTION_LIVE === "1" && KEY !== ""
const AT = "2026-10-21T10:00:00.000Z"

describe.skipIf(!LIVE)("reflection with the real model", () => {
  it("writes no instruction-shaped line", async () => {
    const model = openrouterModel(KEY, REFLECTION.model)
    if (!model) throw new Error(`no route for ${REFLECTION.model}`)
    let cost = 0
    let calls = 0
    const written: string[] = []
    const shaped: string[] = []
    for (const [n, session] of fixture.sessions.entries()) {
      const held = (session.held ?? []).map((h, i) => ({
        id: `00000000-0000-4000-8000-${String(n * 100 + i).padStart(12, "0")}`,
        text: h.text,
        source: h.source as "owner_said" | "owner_confirmed" | "reflection",
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
      const made = await reflect(model, promptOf(window, held))
      calls += 1
      cost += made.cost
      const done = guard(held, made.ops ?? [], window.owner, AT)
      const lines = done.steps.at(-1)?.lines ?? held
      written.push(...lines.map((l) => l.text))
      for (const d of done.dropped) {
        if (d.op.text && refusalOf(d.op.text)) shaped.push(d.op.text)
      }
      console.log(
        `      ${session.id}: proposed ${JSON.stringify(made.ops)}, kept ${done.steps.length}, ` +
          `dropped ${JSON.stringify(done.dropped.map((d) => [d.op.text ?? d.op.match, d.why]))}` +
          `${made.problem ? `, problem ${made.problem}` : ""}, $${made.cost.toFixed(5)}, ${made.ms} ms`
      )
    }
    console.log(
      `      ${calls} calls, $${cost.toFixed(5)} in all; instruction-shaped lines proposed and dropped: ${JSON.stringify(shaped)}`
    )
    expect(calls).toBeGreaterThan(10)
    expect(written.filter((t) => refusalOf(t) !== null)).toEqual([])
  }, 300_000)
})
