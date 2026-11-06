import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  type Ask,
  NARRATE,
  NARRATOR,
  type NarratorAnswer,
  type NarratorBody,
  narrator,
} from "../src/cos/narrator.ts"
import { NARRATE_CASES, narrateShape } from "./narrator-cases.ts"

const answer = (text: string, costUsd = 0.00003): NarratorAnswer => ({
  text,
  provider: "Relace",
  promptTokens: 900,
  cachedTokens: 800,
  costUsd,
})

/** A model that answers each call with the next of `lines` after `ms`. */
function model(lines: string[], ms = 500) {
  const bodies: NarratorBody[] = []
  const ask: Ask = (body) => {
    bodies.push(structuredClone(body))
    const line = lines.shift() ?? ""
    return new Promise((resolve) => setTimeout(() => resolve(answer(line)), ms))
  }
  return { ask, bodies }
}

function start(ask: Ask, message = "Remind me Tuesday to call Mrs Patel") {
  const sent: string[] = []
  let spent = 0
  const n = narrator({
    turnId: "T1",
    message,
    ask,
    send: (line) => sent.push(line),
    spend: (usd) => {
      spent += usd
    },
  })
  return { n, sent, spent: () => spent }
}

describe("the narrator", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, "log").mockImplementation(() => undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("speaks after 1.2 s of thinking, then every 2.5 s while something new comes", async () => {
    const { ask, bodies } = model([
      "Reading the message about Mrs Patel",
      "Setting Tuesday's reminder to call Mrs Patel",
    ])
    const { n, sent } = start(ask)
    n.reasoning("**Planning** Tuesday is 10 November.")
    await vi.advanceTimersByTimeAsync(1_199)
    expect(bodies).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(bodies).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(sent).toEqual(["Reading the message about Mrs Patel"])
    // Nothing new: no call.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(bodies).toHaveLength(1)
    n.reasoning(" Morning means 9am.")
    await vi.advanceTimersByTimeAsync(2_500)
    expect(bodies).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(500)
    expect(sent.at(-1)).toBe("Setting Tuesday's reminder to call Mrs Patel")
    expect(n.spoke).toBe(true)
    n.stop()
  })

  it("sends a cache-friendly body: the fixed prompt first, the log only growing, one key a turn", async () => {
    const { ask, bodies } = model(["Reading the message", "Checking Tuesday"])
    const { n } = start(ask)
    n.reasoning("Need the reminders skill.")
    await vi.advanceTimersByTimeAsync(1_700)
    n.toolStarted("c1")
    n.toolInput("c1", "skill_view", { name: "reminders-and-time" })
    n.toolEnded("c1")
    await vi.advanceTimersByTimeAsync(3_000)
    expect(bodies).toHaveLength(2)
    const [first, second] = bodies as [NarratorBody, NarratorBody]
    expect(first.messages[0]).toEqual({ role: "system", content: NARRATE })
    expect(NARRATE).not.toMatch(/\d{4}-\d\d|T1/)
    expect(second.messages.slice(0, first.messages.length)).toEqual(
      first.messages
    )
    expect(second.messages.slice(first.messages.length)).toEqual([
      { role: "assistant", content: "Reading the message" },
      {
        role: "user",
        content: 'Tool: skill_view {"name":"reminders-and-time"}',
      },
    ])
    for (const body of bodies) {
      expect(body).toMatchObject({
        model: NARRATOR.model,
        temperature: 0,
        reasoning: { enabled: false },
        provider: {
          order: ["relace/fast", "together", "wafer/us", "cohere"],
          allow_fallbacks: false,
        },
        prompt_cache_key: "narrator-T1",
      })
    }
    n.stop()
  })

  it("waits while a tool runs and stops at the reply's words", async () => {
    const { ask, bodies } = model(["Checking the diary"])
    const { n } = start(ask)
    n.toolStarted("c1")
    await vi.advanceTimersByTimeAsync(5_000)
    expect(bodies).toHaveLength(0)
    n.toolEnded("c1")
    n.words()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(bodies).toHaveLength(0)
    n.stop()
  })

  it("drops a line that comes after the words, repeats the last, has the wrong shape or fails", async () => {
    const late = model(["Checking the diary"], 800)
    const one = start(late.ask)
    await vi.advanceTimersByTimeAsync(1_300)
    one.n.words()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(one.sent).toEqual([])
    // Paid for all the same.
    expect(one.spent()).toBeGreaterThan(0)
    one.n.stop()

    const again = model(["Checking the diary", "checking the diary."])
    const two = start(again.ask)
    await vi.advanceTimersByTimeAsync(1_800)
    two.n.reasoning("more")
    await vi.advanceTimersByTimeAsync(3_000)
    expect(again.bodies).toHaveLength(2)
    expect(two.sent).toEqual(["Checking the diary"])
    two.n.stop()

    const long = model(["Checking ".repeat(10)])
    const three = start(long.ask)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(three.sent).toEqual([])
    three.n.stop()

    const failing = start(() => Promise.reject(new Error("502")))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(failing.sent).toEqual([])
    expect(failing.n.spoke).toBe(false)
    failing.n.stop()
  })

  it("gives up on a call past its time, never holding the turn", async () => {
    let aborted = false
    const { n, sent } = start(
      (_, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => {
            aborted = true
            reject(new Error("aborted"))
          })
        )
    )
    await vi.advanceTimersByTimeAsync(1_200 + NARRATOR.timeoutMs)
    expect(aborted).toBe(true)
    expect(sent).toEqual([])
    n.stop()
  })

  it("logs each call's host, tokens, latency and cost", async () => {
    const log = vi.mocked(console.log)
    const { ask } = model(["Checking the diary"])
    const { n } = start(ask)
    await vi.advanceTimersByTimeAsync(2_000)
    const line = JSON.parse(String(log.mock.calls.at(-1)?.[0]))
    expect(line).toEqual({
      code: "cos.narrator",
      turn_id: "T1",
      outcome: "shown",
      ms: 500,
      provider: "Relace",
      prompt_tokens: 900,
      cached_tokens: 800,
      cost_usd: 0.00003,
    })
    n.stop()
  })

  describe.each(NARRATE_CASES)("benchmark case $id", (c) => {
    it("reaches the model as the owner's message, the reasoning and the tools", async () => {
      const { ask, bodies } = model([c.good])
      const { n, sent } = start(ask, c.message)
      n.reasoning(c.reasoning)
      for (const [i, [name, args]] of c.tools.entries()) {
        n.toolStarted(`c${i}`)
        n.toolInput(`c${i}`, name, args)
        n.toolEnded(`c${i}`)
      }
      await vi.advanceTimersByTimeAsync(2_000)
      const user = bodies[0]?.messages[1]?.content ?? ""
      expect(user).toContain(`Owner: ${c.message}`)
      if (c.reasoning) expect(user).toContain(`Reasoning: ${c.reasoning}`)
      for (const [name] of c.tools) expect(user).toContain(`Tool: ${name} `)
      expect(sent).toEqual([c.good])
      expect(narrateShape(c.good) && c.check(c.good)).toBe(true)
      n.stop()
    })
  })
})
