import { existsSync, readFileSync } from "node:fs"
import { parseEnv } from "node:util"
import { convertToModelMessages, streamText, type UIMessage } from "ai"
import { describe, it } from "vitest"
import { cosModel } from "../src/chat.ts"
import {
  activeTools,
  CACHED_INSTRUCTIONS,
  cosAgent,
  PREFIX_KEY,
  stepCost,
  withHistoryMarker,
} from "../src/cos/agent.ts"
import { CONTEXT_POLICY, deriveCosMessages } from "../src/cos/history.ts"
import { thoughtHeadings } from "../src/thinking.ts"
import recorded from "./cos-compaction-session.json" with { type: "json" }

/**
 * Live: whether the owner turn's reasoning reaches us as summaries with
 * headings, how soon, and what the turn's first call costs and caches.
 * Runs only with `REASONING_LIVE=1` and `OPENROUTER_API_KEY`.
 */

const KEY =
  process.env.OPENROUTER_API_KEY ??
  (existsSync(".dev.vars")
    ? (parseEnv(readFileSync(".dev.vars", "utf8")).OPENROUTER_API_KEY ?? "")
    : "")
const LIVE = process.env.REASONING_LIVE === "1" && KEY !== ""
const TOOLS = cosAgent({} as never, {} as never, "act").tools
type Row = { type: string; payload: unknown }

async function firstCall(tag: string, k: number) {
  const rows: Row[] = []
  for (const turn of (recorded.turns as Row[][]).slice(0, k + 1)) {
    for (const row of turn) {
      rows.push(row)
      if (row.type === "cos.context" && turn === recorded.turns[k]) break
    }
  }
  const log = rows.map((row, seq) => {
    if (row.type === "cos.context") {
      const payload = {
        ...(row.payload as object),
        context_policy_version: CONTEXT_POLICY.version,
      }
      return { seq, ...row, payload }
    }
    if (seq !== 0) return { seq, ...row }
    const p = row.payload as { message: UIMessage }
    const text = p.message.parts
      .map((x) => (x.type === "text" ? x.text : ""))
      .join("")
    const message = {
      ...p.message,
      parts: [{ type: "text", text: `[${tag}] ${text}` }],
    }
    return { seq, ...row, payload: { ...p, message } }
  })
  const note = (
    log.filter((e) => e.type === "cos.context").at(-1)?.payload as
      | { text: string }
      | undefined
  )?.text
  const { messages } = deriveCosMessages(log, CONTEXT_POLICY)
  const model = await convertToModelMessages(messages as UIMessage[], {
    tools: TOOLS,
  })
  return withHistoryMarker(model, note)
}

describe.skipIf(!LIVE)("reasoning summaries on the owner turn", () => {
  it("measures", async () => {
    const route = cosModel({ OPENROUTER_API_KEY: KEY } as Env)
    const price = route.price
    if (!route.model || !price) throw new Error("no owner turn route")
    const tag = `r-${Date.now()}`
    let total = 0
    for (const k of [30, 31]) {
      const messages = await firstCall(tag, k)
      const t0 = Date.now()
      let firstReasoning: number | null = null
      let firstHeading: number | null = null
      let firstText: number | null = null
      let reasoningChars = 0
      const headings: string[] = []
      const types = new Set<string>()
      const think = thoughtHeadings((line) => {
        headings.push(line)
        firstHeading ??= Date.now() - t0
      })
      const result = streamText({
        model: route.model,
        instructions: CACHED_INSTRUCTIONS,
        tools: TOOLS,
        activeTools: activeTools("act"),
        toolChoice: "none",
        messages,
        maxOutputTokens: 1500,
        providerOptions: {
          openrouter: {
            session_id: await PREFIX_KEY,
            prompt_cache_key: await PREFIX_KEY,
          },
        },
      })
      for await (const part of result.fullStream) {
        types.add(part.type)
        if (part.type === "reasoning-delta") {
          firstReasoning ??= Date.now() - t0
          reasoningChars += part.text.length
          think(part.text)
        }
        if (part.type === "text-delta") firstText ??= Date.now() - t0
      }
      const usage = await result.usage
      const steps = await result.steps
      const cost = steps.reduce((sum, step) => sum + stepCost(price, step), 0)
      total += cost
      const input = usage.inputTokens ?? 0
      const cached = usage.inputTokenDetails.cacheReadTokens ?? 0
      console.log(
        JSON.stringify({
          k,
          model: (await result.response).modelId,
          input,
          cached,
          share: Math.round((100 * cached) / input),
          reasoningTokens: usage.outputTokenDetails.reasoningTokens,
          reasoningChars,
          firstReasoning,
          firstHeading,
          firstText,
          headings,
          cost: cost.toFixed(4),
          types: [...types],
        })
      )
    }
    console.log(`total $${total.toFixed(4)}`)
  }, 300_000)
})
