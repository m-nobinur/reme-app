import { existsSync, readFileSync } from "node:fs"
import { parseEnv } from "node:util"
import { convertToModelMessages, streamText, type UIMessage } from "ai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
import { narrator, openrouterAsk } from "../src/cos/narrator.ts"
import recorded from "./cos-compaction-session.json" with { type: "json" }
import { NARRATE_CASES, narrateShape } from "./narrator-cases.ts"

/**
 * Live: the narrator on its real model. The benchmark's cases first, each a
 * turn of two updates, then recorded owner turns streamed on the real CoS
 * model with the narrator beside them, as `streamTurn` runs it. Prints each
 * line, its latency, host and cached share, and per turn the first line's
 * time, the lines, the first word and what the narrator added to the cost.
 * Runs only with `NARRATOR_LIVE=1` and `OPENROUTER_API_KEY`.
 */

const KEY =
  process.env.OPENROUTER_API_KEY ??
  (existsSync(".dev.vars")
    ? (parseEnv(readFileSync(".dev.vars", "utf8")).OPENROUTER_API_KEY ?? "")
    : "")
const LIVE = process.env.NARRATOR_LIVE === "1" && KEY !== ""
/** What the model wrote on each call, kept or dropped, in call order. */
let wrote: string[] = []
const live = openrouterAsk(KEY)
const ask: typeof live = async (body, signal) => {
  const answer = await live(body, signal)
  wrote.push(answer.text)
  return answer
}
type Row = { type: string; payload: unknown }
type Logged = {
  outcome: string
  ms: number
  provider: string | null
  prompt_tokens: number | null
  cached_tokens: number | null
  cost_usd: number | null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The recorded session's history up to turn `k`'s owner message, as the model is sent it. */
async function historyAt(k: number) {
  const rows: Row[] = []
  for (const turn of (recorded.turns as Row[][]).slice(0, k + 1)) {
    for (const row of turn) {
      rows.push(row)
      if (row.type === "cos.context" && turn === recorded.turns[k]) break
    }
  }
  const log = rows.map((row, seq) =>
    row.type === "cos.context"
      ? {
          seq,
          ...row,
          payload: {
            ...(row.payload as object),
            context_policy_version: CONTEXT_POLICY.version,
          },
        }
      : { seq, ...row }
  )
  const note = (
    log.filter((e) => e.type === "cos.context").at(-1)?.payload as
      | { text: string }
      | undefined
  )?.text
  const { messages } = deriveCosMessages(log, CONTEXT_POLICY)
  const owner = (messages.at(-1)?.parts ?? [])
    .flatMap((p) => (p.type === "text" ? [p.text] : []))
    .join("\n")
  const model = await convertToModelMessages(messages as UIMessage[], {
    tools: TOOLS,
  })
  return { owner, messages: withHistoryMarker(model, note) }
}

// Calls are shown to the narrator, never run.
const TOOLS = Object.fromEntries(
  Object.entries(cosAgent({} as never, {} as never, "act").tools).map(
    ([name, t]) => [name, { ...t, execute: undefined }]
  )
) as unknown as ReturnType<typeof cosAgent>["tools"]

describe.skipIf(!LIVE)("the narrator, live", () => {
  let logged: Logged[] = []
  beforeEach(() => {
    logged = []
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      const read = JSON.parse(String(line)) as { code?: string } & Logged
      if (read.code === "cos.narrator") logged.push(read)
    })
  })
  afterEach(() => vi.restoreAllMocks())
  const print = (row: object) =>
    process.stdout.write(`${JSON.stringify(row)}\n`)

  it("writes a specific line for each benchmark case", async () => {
    for (const c of NARRATE_CASES) {
      logged = []
      wrote = []
      const lines: string[] = []
      const n = narrator({
        turnId: `live-${c.id}-${Date.now()}`,
        message: c.message,
        ask,
        send: (line) => lines.push(line),
        spend: () => undefined,
      })
      n.reasoning(c.reasoning)
      await sleep(3_200)
      for (const [i, [name, args]] of c.tools.entries()) {
        n.toolStarted(`c${i}`)
        n.toolInput(`c${i}`, name, args)
        n.toolEnded(`c${i}`)
      }
      await sleep(4_000)
      n.stop()
      // A failed call wrote nothing, so the words pair with the calls that answered.
      const answered = logged.filter((call) => call.provider !== null)
      for (const call of logged)
        print({
          case: c.id,
          wrote: call.provider === null ? null : wrote[answered.indexOf(call)],
          outcome: call.outcome,
          ms: call.ms,
          provider: call.provider,
          cached: `${Math.round((100 * (call.cached_tokens ?? 0)) / (call.prompt_tokens || 1))}%`,
          cost: call.cost_usd,
        })
      expect(lines.length, c.id).toBeGreaterThan(0)
      for (const line of lines) {
        expect(narrateShape(line), line).toBe(true)
      }
      expect(lines.some(c.check), lines.join(" | ")).toBe(true)
    }
  }, 60_000)

  it("runs beside recorded owner turns on the real CoS model", async () => {
    const route = cosModel({ OPENROUTER_API_KEY: KEY } as Env)
    if (!route.model || !route.price) throw new Error("no owner turn route")
    const price = route.price
    let narratorUsd = 0
    let cosUsd = 0
    for (const k of [23, 28, 34, 59]) {
      logged = []
      wrote = []
      const { owner, messages } = await historyAt(k)
      const t0 = Date.now()
      const lines: { at: number; line: string }[] = []
      let spent = 0
      const n = narrator({
        turnId: `live-turn-${k}-${t0}`,
        message: owner,
        ask,
        send: (line) => lines.push({ at: Date.now() - t0, line }),
        spend: (usd) => {
          spent += usd
        },
      })
      let firstWord: number | null = null
      const tools: string[] = []
      const result = streamText({
        model: route.model,
        instructions: CACHED_INSTRUCTIONS,
        tools: TOOLS,
        activeTools: activeTools("act"),
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
        if (part.type === "reasoning-delta") n.reasoning(part.text)
        else if (part.type === "text-delta") {
          firstWord ??= Date.now() - t0
          n.words()
        } else if (part.type === "tool-input-start") n.toolStarted(part.id)
        else if (part.type === "tool-call") {
          tools.push(part.toolName)
          n.toolInput(part.toolCallId, part.toolName, part.input)
        }
      }
      const ended = Date.now() - t0
      // A call in flight at the end lands or is dropped; its cost still counts.
      await sleep(2_100)
      n.stop()
      const steps = await result.steps
      const cos = steps.reduce((sum, step) => sum + stepCost(price, step), 0)
      cosUsd += cos
      narratorUsd += spent
      const cachedShare =
        logged.reduce((s, c) => s + (c.cached_tokens ?? 0), 0) /
        Math.max(
          1,
          logged.reduce((s, c) => s + (c.prompt_tokens ?? 0), 0)
        )
      print({
        turn: k,
        owner: owner.slice(0, 60),
        first_line_ms: lines[0]?.at ?? null,
        lines: lines.map((l) => `${l.at}ms ${l.line}`),
        calls: logged.map(
          (c) =>
            `${c.outcome} ${c.ms}ms ${c.provider} "${c.provider === null ? "" : wrote[logged.filter((l) => l.provider !== null).indexOf(c)]}"`
        ),
        first_word_ms: firstWord,
        ended_ms: ended,
        tools,
        narrator_cached: `${Math.round(100 * cachedShare)}%`,
        narrator_usd: spent.toFixed(6),
        cos_usd: cos.toFixed(4),
        added: `${((100 * spent) / Math.max(cos, 1e-9)).toFixed(1)}%`,
      })
    }
    print({
      narrator_usd: narratorUsd.toFixed(5),
      cos_usd: cosUsd.toFixed(4),
    })
  }, 240_000)
})
