import { convertToModelMessages, generateText, type UIMessage } from "ai"
import { describe, expect, it } from "vitest"
import {
  cosAgent,
  DEFAULT_MODEL,
  INSTRUCTIONS,
  openrouterModel,
  priceOf,
  stepCost,
} from "../src/cos/agent.ts"
import { COMPACTION, planCompaction, summarise } from "../src/cos/compaction.ts"
import {
  CONTEXT_POLICY,
  deriveCosMessages,
  loggedMessages,
} from "../src/cos/history.ts"
import recorded from "./cos-compaction-session.json" with { type: "json" }

/**
 * Live: compaction (ADR-042) over the scripted 60-turn session with the
 * real summary model. The job's plan runs after every turn and each summary
 * is written as the job writes it; then the CoS's model is asked the ten
 * seeded facts over the history the next turn would read. It passes when
 * every summary was kept, both approvals of the last turn are still open on
 * their cards, and every fact is answered. Prints each compaction's cost
 * and latency. It spends money, so it runs only with `COMPACTION_LIVE=1`
 * and `OPENROUTER_API_KEY`.
 */

const KEY = process.env.OPENROUTER_API_KEY ?? ""
const LIVE = process.env.COMPACTION_LIVE === "1" && KEY !== ""
const CANCELLED = "User cancelled tool call by sending a new message."

/** The CoS's tools as the model is shown them. Building the agent runs nothing. */
const TOOLS = cosAgent({} as never, {} as never, "ask").tools

type Row = { type: string; payload: unknown }

describe.skipIf(!LIVE)("compaction with the real models", () => {
  it("keeps the open approvals and every seeded fact", async () => {
    const summaryModel = openrouterModel(KEY, COMPACTION.model)
    if (!summaryModel) throw new Error(`no route for ${COMPACTION.model}`)
    const log: { seq: number; type: string; payload: unknown }[] = []
    const add = (row: Row) => log.push({ seq: log.length, ...row })
    const made: {
      turn: number
      summary: Awaited<ReturnType<typeof summarise>>
    }[] = []
    for (const [i, rows] of (recorded.turns as Row[][]).entries()) {
      for (const row of rows) add(row)
      const plan = planCompaction(log)
      if (!plan) continue
      const summary = await summarise(summaryModel, plan)
      made.push({ turn: i + 1, summary })
      console.log(
        `      compaction after turn ${i + 1}: history ${plan.historyTokens} tokens, ` +
          `seqs ${plan.replaced_range.from_seq} to ${plan.replaced_range.to_seq}, ` +
          `in ${summary.usage?.input_tokens ?? "?"} out ${summary.usage?.output_tokens ?? "?"} tokens, ` +
          `$${summary.cost.toFixed(5)}, ${summary.ms} ms${summary.problem ? `, rejected: ${summary.problem}` : ""}`
      )
      if (summary.summary === null) {
        throw new Error(`the summary after turn ${i + 1} was rejected`)
      }
      add({
        type: "cos.compaction",
        payload: {
          summary: summary.summary,
          replaced_range: plan.replaced_range,
          dropped_refs: [],
        },
      })
    }
    if (made.length === 0) throw new Error("the session never compacted")

    const next = loggedMessages(log, log.length).map((m) => m.message)
    const open = next
      .flatMap((m) => m.parts)
      .filter((p) => p.state === "approval-requested")
      .map((p) => (p.approval as { id: string }).id)
    expect(open).toEqual(recorded.open_approvals)

    // The owner's next message, as the chat logs it: the waiting cards
    // cancelled, then the question and the turn's context.
    const tail = next.find((m) => m.id === "a60") as (typeof next)[number]
    const turnId = "01K6C000000000000000000061"
    add({
      type: "cos.message",
      payload: {
        turn_id: turnId,
        message: {
          ...tail,
          parts: tail.parts.map((p) =>
            p.state === "approval-requested"
              ? {
                  type: p.type,
                  toolCallId: p.toolCallId,
                  state: "output-error",
                  input: p.input,
                  errorText: CANCELLED,
                }
              : p
          ),
        },
      },
    })
    const questions = recorded.facts.map((f, i) => `${i + 1}. ${f.question}`)
    add({
      type: "cos.message",
      payload: {
        turn_id: turnId,
        message: {
          id: "u61",
          role: "user",
          parts: [
            {
              type: "text",
              text: `Quick check before I forget, answer each on its own numbered line:\n${questions.join("\n")}`,
            },
          ],
        },
      },
    })
    add({
      type: "cos.context",
      payload: {
        turn_id: turnId,
        prefix_sha256: "a".repeat(64),
        context_policy_version: CONTEXT_POLICY.version,
        mode: "ask",
        active_tools: [],
        text: "Mode: ask. You may only read. For a change, the owner switches to Act.\nNow: 2026-10-01T10:00 (Europe/London)",
        reserved_usd: 0.05,
      },
    })
    const { messages } = deriveCosMessages(log, CONTEXT_POLICY)
    const cos = openrouterModel(KEY, DEFAULT_MODEL)
    if (!cos) throw new Error(`no route for ${DEFAULT_MODEL}`)
    const began = Date.now()
    const answer = await generateText({
      model: cos,
      system: INSTRUCTIONS,
      messages: await convertToModelMessages(messages as UIMessage[], {
        tools: TOOLS,
      }),
      tools: TOOLS,
      toolChoice: "none",
      maxOutputTokens: 3_100,
      maxRetries: 1,
    })
    const price = priceOf(DEFAULT_MODEL) as NonNullable<
      ReturnType<typeof priceOf>
    >
    console.log(
      `      answer: ${answer.usage.inputTokens} in, ${answer.usage.outputTokens} out, ` +
        `$${stepCost(price, answer).toFixed(5)}, ${Date.now() - began} ms`
    )
    const lines = answer.text.split("\n")
    const missed = recorded.facts.filter((fact, i) => {
      const line =
        lines.find((l) => new RegExp(`^\\W*${i + 1}[.):]`).test(l.trim())) ?? ""
      return !fact.answer.some((a) =>
        line.toLowerCase().includes(a.toLowerCase())
      )
    })
    console.log(answer.text.replace(/^/gm, "        "))
    const total = made.reduce((sum, m) => sum + m.summary.cost, 0)
    console.log(
      `      ${made.length} compactions, $${total.toFixed(5)} in all; ${recorded.facts.length - missed.length} of ${recorded.facts.length} facts answered; approvals open: ${open.join(", ")}`
    )
    expect(missed.map((f) => f.question)).toEqual([])
  }, 600_000)
})
