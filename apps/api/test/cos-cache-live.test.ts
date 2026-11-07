import { existsSync, readFileSync } from "node:fs"
import { parseEnv } from "node:util"
import {
  convertToModelMessages,
  generateText,
  type ModelMessage,
  type UIMessage,
} from "ai"
import { describe, expect, it } from "vitest"
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
import recorded from "./cos-compaction-session.json" with { type: "json" }

/**
 * Live: how much of a turn's first call reads from cache after the turn
 * before it, over the scripted session with the owner turn's model, route
 * and cached prefix. Each variant tags the first owner message, so it reads
 * nothing another variant wrote. It spends money (about $0.10 a variant), so
 * it runs only with `CACHE_LIVE=1` and `OPENROUTER_API_KEY`.
 */

const KEY =
  process.env.OPENROUTER_API_KEY ??
  (existsSync(".dev.vars")
    ? (parseEnv(readFileSync(".dev.vars", "utf8")).OPENROUTER_API_KEY ?? "")
    : "")
const LIVE = process.env.CACHE_LIVE === "1" && KEY !== ""
const TOOLS = cosAgent({} as never, {} as never, "act").tools
const FROM = 30

type Row = { type: string; payload: unknown }
type Mark = (
  messages: ModelMessage[],
  note: string | undefined
) => ModelMessage[]

/** Turn `k`'s first call: the session up to its context, as the turn derives it. */
async function firstCall(tag: string, k: number) {
  const rows: Row[] = []
  for (const turn of (recorded.turns as Row[][]).slice(0, k + 1)) {
    for (const row of turn) {
      rows.push(row)
      if (row.type === "cos.context" && turn === recorded.turns[k]) break
    }
  }
  const log = rows.map((row, seq) => ({
    seq,
    ...row,
    payload:
      row.type === "cos.context"
        ? {
            ...(row.payload as object),
            context_policy_version: CONTEXT_POLICY.version,
          }
        : seq === 0
          ? tagged(row.payload, tag)
          : row.payload,
  }))
  const note = (
    log.filter((e) => e.type === "cos.context").at(-1)?.payload as
      | { text: string }
      | undefined
  )?.text
  const { messages } = deriveCosMessages(log, CONTEXT_POLICY)
  return {
    note,
    messages: await convertToModelMessages(messages as UIMessage[], {
      tools: TOOLS,
    }),
  }
}

const tagged = (payload: unknown, tag: string) => {
  const p = payload as { message: UIMessage }
  return {
    ...p,
    message: {
      ...p.message,
      parts: [{ type: "text", text: `[${tag}] ${textOf(p.message)}` }],
    },
  }
}

const textOf = (m: UIMessage) =>
  m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")

describe.skipIf(!LIVE)("prompt cache between turns", () => {
  const route = cosModel({ OPENROUTER_API_KEY: KEY } as Env)
  const run = async (tag: string, mark: Mark) => {
    if (!route.model || !route.price) throw new Error("no owner turn route")
    const shares: number[] = []
    let cost = 0
    for (const k of [FROM, FROM + 1]) {
      const { note, messages } = await firstCall(tag, k)
      const result = await generateText({
        model: route.model,
        instructions: CACHED_INSTRUCTIONS,
        tools: TOOLS,
        activeTools: activeTools("act"),
        toolChoice: "none",
        messages: mark(messages, note),
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
      cost += stepCost(route.price, result)
      shares.push(cached / input)
      console.log(
        `      ${tag} turn ${k}: ${input} in, ${cached} cached (${Math.round((100 * cached) / input)}%), ` +
          `written ${result.usage.inputTokenDetails.cacheWriteTokens ?? 0}, ${result.response.modelId}`
      )
    }
    console.log(`      ${tag}: $${cost.toFixed(4)}`)
    return shares
  }

  it("reads the history from cache with the rolling marker", async () => {
    const tag = `${Date.now()}`
    const before = await run(`before-${tag}`, (m) => m)
    const after = await run(`after-${tag}`, withHistoryMarker)
    expect(Math.min(...after.slice(1))).toBeGreaterThan(
      Math.max(...before.slice(1))
    )
  }, 300_000)
})
