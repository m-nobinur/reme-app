import { existsSync, readFileSync } from "node:fs"
import { parseEnv } from "node:util"
import { generateText, type ModelMessage } from "ai"
import { describe, expect, it } from "vitest"
import { cosModel } from "../src/chat.ts"
import {
  activeTools,
  CACHED_INSTRUCTIONS,
  contextOf,
  cosAgent,
  instructionsFor,
  memoryText,
  PREFIX_KEY,
  personaOf,
  stepCost,
  withHistoryMarker,
} from "../src/cos/agent.ts"

/**
 * Live: each turn's cached share over a three-turn conversation with the
 * owner profile and working notes near full, on the owner turn's model.
 * `context` sends memory in the turn's context note, as before the frozen
 * snapshot; `snapshot` sends it as its own system block after the
 * instructions. Each run tags its memory and first message, so it reads
 * nothing another run wrote. About $0.10 a run, so it runs only with
 * `CACHE_LIVE=1` and `OPENROUTER_API_KEY`, or a `.dev.vars` (`DEV_VARS`)
 * holding it.
 */

const VARS = process.env.DEV_VARS ?? ".dev.vars"
const KEY =
  process.env.OPENROUTER_API_KEY ??
  (existsSync(VARS)
    ? (parseEnv(readFileSync(VARS, "utf8")).OPENROUTER_API_KEY ?? "")
    : "")
const LIVE = process.env.CACHE_LIVE === "1" && KEY !== ""
const TOOLS = cosAgent({} as never, {} as never, "act").tools
const EMPTY = {
  site: { host: null, live_version: null },
  builds: [],
  questions: [],
  approvals: [],
  missing_facts: [],
}
const AT = "2026-11-07T09:00:00.000Z"

/** Lines of about `width` characters filling `budget`, the first carrying `tag`. */
const filled = (tag: string, what: string, budget: number, width = 70) =>
  Array.from({ length: Math.floor(budget / (width + 1)) }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    text: `${i === 0 ? `[${tag}] ` : ""}${what} ${i + 1}: ${"keeps to the usual Tuesday round ".repeat(3)}`.slice(
      0,
      width
    ),
    source: "owner_said" as const,
    at: AT,
  }))

const text = (t: string) => [{ type: "text" as const, text: t }]

describe.skipIf(!LIVE)("memory's cached share per turn", () => {
  const route = cosModel({ OPENROUTER_API_KEY: KEY } as Env)

  const run = async (layout: "context" | "snapshot") => {
    if (!route.model || !route.price) throw new Error("no owner turn route")
    const tag = `${layout}-${Date.now()}`
    const persona = personaOf(
      [],
      filled(tag, "Owner detail", 1_550),
      filled(tag, "Business note", 3_400)
    )
    const memory = memoryText(persona)
    const history: ModelMessage[] = []
    const rows: { input: number; cached: number; cost: number }[] = []
    for (const [k, said] of [
      `[${tag}] Morning, what's on today?`,
      "Can you remind me what Mrs Patel prefers?",
      "Thanks, and the van keys?",
    ].entries()) {
      const note = contextOf(
        "ask",
        EMPTY,
        "Europe/London",
        new Date(AT),
        undefined,
        persona,
        k === 0
      ).text
      const sent = layout === "context" ? `${note}\n${memory}` : note
      const result = await generateText({
        model: route.model,
        instructions:
          layout === "context" ? CACHED_INSTRUCTIONS : instructionsFor(memory),
        tools: TOOLS,
        activeTools: activeTools("act"),
        toolChoice: "none",
        messages: withHistoryMarker(
          [
            ...history,
            { role: "user", content: text(sent) },
            { role: "user", content: text(said) },
          ],
          sent
        ),
        maxOutputTokens: 16,
        providerOptions: {
          openrouter: {
            session_id: await PREFIX_KEY,
            prompt_cache_key: await PREFIX_KEY,
          },
        },
      })
      const input = result.usage.inputTokens ?? 0
      const cached = result.usage.inputTokenDetails.cacheReadTokens ?? 0
      const cost = stepCost(route.price, result)
      rows.push({ input, cached, cost })
      console.log(
        `      ${layout} turn ${k + 1}: ${input} in, ${cached} cached (${Math.round((100 * cached) / input)}%), $${cost.toFixed(5)}, ${result.response.modelId}`
      )
      history.push(
        { role: "user", content: text(said) },
        { role: "assistant", content: text(`Reply ${k + 1}.`) }
      )
    }
    const total = rows.reduce((sum, r) => sum + r.cost, 0)
    console.log(`      ${layout}: $${total.toFixed(5)} over three turns`)
    return rows
  }

  it("reads memory from cache on every turn after the first", async () => {
    const before = await run("context")
    const after = await run("snapshot")
    for (const k of [1, 2]) {
      expect(after[k]?.cached ?? 0).toBeGreaterThan(before[k]?.cached ?? 0)
    }
  }, 300_000)
})
