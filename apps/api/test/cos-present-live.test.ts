import { existsSync, readFileSync } from "node:fs"
import { parseEnv } from "node:util"
import { procedure } from "@workspace/skills"
import { hasToolCall, isStepCount, streamText } from "ai"
import { describe, expect, it } from "vitest"
import { cosModel } from "../src/chat.ts"
import {
  activeTools,
  CACHED_INSTRUCTIONS,
  cosAgent,
  PREFIX_KEY,
  stepCost,
} from "../src/cos/agent.ts"

/**
 * Live (#741): whether the owner turn's model presents a comparison and
 * answers a plain question in words. Up to three steps each; only skill_view and present run.
 * Runs only with `PRESENT_LIVE=1` and `OPENROUTER_API_KEY`.
 */

const KEY =
  process.env.OPENROUTER_API_KEY ??
  (existsSync(".dev.vars")
    ? (parseEnv(readFileSync(".dev.vars", "utf8")).OPENROUTER_API_KEY ?? "")
    : "")
const LIVE = process.env.PRESENT_LIVE === "1" && KEY !== ""
/** Skills are read for real and present closes at once; any other call ends the run unexecuted. */
const RUNS: Record<string, (input: { name?: string }) => unknown> = {
  skill_view: ({ name }) => ({
    name,
    body: procedure("cos", name ?? "")?.body,
  }),
  present: () => ({ outcome: "presented" }),
}
const TOOLS = Object.fromEntries(
  Object.entries(cosAgent({} as never, {} as never, "act").tools).map(
    ([name, { execute: _, ...rest }]) => [
      name,
      RUNS[name] ? { ...rest, execute: RUNS[name] } : rest,
    ]
  )
)

const CONTEXT =
  "Mode: act. Now: Friday 6 November 2026, 9:12 AM, Europe/London. The business is Sparkle Clean, a home cleaner in Bristol. Its prices: weekly clean £60 a visit, fortnightly clean £70 a visit, deep clean £180."

describe.skipIf(!LIVE)("present on the owner turn", () => {
  it("presents a comparison and writes prose for a plain question", async () => {
    const route = cosModel({ OPENROUTER_API_KEY: KEY } as Env)
    const { model, price } = route
    if (!model || !price) throw new Error("no owner turn route")
    let total = 0
    const run = async (ask: string) => {
      const result = streamText({
        model,
        instructions: CACHED_INSTRUCTIONS,
        tools: TOOLS,
        activeTools: activeTools("act"),
        messages: [
          { role: "user", content: CONTEXT },
          { role: "user", content: ask },
        ],
        stopWhen: [isStepCount(3), hasToolCall("present")],
        maxOutputTokens: 1500,
        providerOptions: {
          openrouter: {
            session_id: await PREFIX_KEY,
            prompt_cache_key: await PREFIX_KEY,
          },
        },
      })
      const steps = await result.steps
      const cost = steps.reduce((sum, s) => sum + stepCost(price, s), 0)
      total += cost
      const calls = steps.flatMap((step) =>
        step.toolCalls.map((c) => ({ name: c.toolName, input: c.input }))
      )
      const text = await result.text
      console.log(JSON.stringify({ ask, text, calls, cost: cost.toFixed(4) }))
      return { text, names: calls.map((c) => c.name) }
    }
    const compared = await run(
      "Can you compare a weekly and a fortnightly clean for me, so I can see which to push?"
    )
    const plain = await run(
      "What time do you think I should start work on Mondays?"
    )
    console.log(`total $${total.toFixed(4)}`)
    expect(compared.names).toContain("present")
    expect(plain.names).not.toContain("present")
    expect(plain.text.trim()).not.toBe("")
  }, 120_000)
})
