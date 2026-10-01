import { afterEach, describe, expect, it, vi } from "vitest"
import { decisionOf, JEV, jev } from "../src/jev.ts"
import { choiceCard, detailsCard, type Onboarding } from "../src/onboarding.ts"

const o: Onboarding = {
  orgId: "0f1e2d3c-4b5a-4968-8776-655443322110",
  facts: [],
  passed: [],
  closed: [],
  offered: false,
  builder: null,
  orgName: "Regal Rides",
  ownerName: "Dave",
}
const template = choiceCard("template", o, () => "c1")
const pages = choiceCard("pages", o, () => "c2")
const contact = detailsCard("contact", o, () => "c3")

const answers = (
  answersIt: number,
  kind: string,
  confidence: number,
  option?: [string, number]
) => ({
  answers: {
    answers_it: { type: "noul", noul: answersIt },
    kind: { type: "choice", choice: kind, confidence },
    ...(option
      ? {
          option: {
            type: "choice",
            choice: option[0],
            confidence: option[1],
          },
        }
      : {}),
  },
  usage: { input_tokens: 300, output_tokens: 3, cost: 0.00002 },
})

/** A fetch that answers `body` with `status`, and keeps what it was sent. */
function fake(body: unknown, status = 200) {
  const sent: { url: string; init: RequestInit }[] = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, init })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { fetchImpl, sent }
}

describe("the Jev gate", () => {
  afterEach(() => vi.restoreAllMocks())

  it("takes only a reply that surely answers and surely picks one offered option", () => {
    const ids = ["classic", "modern", "bold"]
    expect(decisionOf(answers(0.97, "answer", 1, ["bold", 0.9]), ids)).toEqual({
      kind: "answer",
      option: "bold",
    })
    expect(decisionOf(answers(0.95, "defer", 0.93), ids)).toEqual({
      kind: "defer",
    })
    for (const unsure of [
      // Off topic, though read as an answer at choice level (measured).
      answers(0.62, "answer", 1, ["bold", 1]),
      // A question mixed with an answer (measured at 0.37).
      answers(0.95, "answer", 0.37, ["bold", 1]),
      answers(0.95, "answer", 1, ["bold", 0.8]),
      answers(0.95, "answer", 1, ["neon", 1]),
      answers(0.95, "other", 1),
      answers(0.95, "answer", 1),
      {},
    ]) {
      expect(decisionOf(unsure, ids)).toBeNull()
    }
  })

  it("asks Jev the card's question with its options as criteria, and logs one line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const { fetchImpl, sent } = fake(answers(1, "answer", 1, ["modern", 1]))
    const decision = await jev(
      "sk-test",
      template,
      "Which layout suits you?",
      "The modern one please",
      fetchImpl
    )
    expect(decision).toEqual({ kind: "answer", option: "modern" })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.url).toBe(JEV.url)
    expect(
      (sent[0]?.init.headers as Record<string, string> | undefined)
        ?.authorization
    ).toBe("Bearer sk-test")
    const body = JSON.parse(sent[0]?.init.body as string)
    expect(body.model).toBe(JEV.model)
    expect(body.state).toEqual({
      assistant_asked: "Which layout suits you?",
      owner_replied: "The modern one please",
    })
    expect(body.questions.answers_it.type).toBe("noul")
    expect(Object.keys(body.questions.kind.criteria)).toEqual([
      "answer",
      "defer",
      "other",
    ])
    expect(Object.keys(body.questions.option.criteria)).toEqual([
      "classic",
      "modern",
      "bold",
    ])
    expect(body.questions.option.options).toBeUndefined()
    const line = JSON.parse(log.mock.calls.at(-1)?.[0] as string)
    expect(line).toMatchObject({
      code: "onboarding.jev",
      step: "template",
      decision: "answer:modern",
      cost_usd: 0.00002,
      error: null,
    })
    expect(typeof line.ms).toBe("number")
  })

  it("never asks which option on a details card or a card that takes several", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    for (const card of [contact, pages]) {
      const { fetchImpl, sent } = fake(answers(1, "answer", 1, ["home", 1]))
      expect(await jev("k", card, "q", "you pick", fetchImpl)).toBeNull()
      expect(JSON.parse(sent[0]?.init.body as string).questions.option).toBe(
        undefined
      )
    }
    const { fetchImpl } = fake(answers(0.99, "defer", 0.99))
    expect(await jev("k", contact, "q", "you choose", fetchImpl)).toEqual({
      kind: "defer",
    })
  })

  it("leaves the reply to the planner on a non-200, an error or a slow answer", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    expect(
      await jev("k", template, "q", "bold", fake({ error: "x" }, 500).fetchImpl)
    ).toBeNull()
    expect(JSON.parse(log.mock.calls.at(-1)?.[0] as string).error).toBe(
      "status 500"
    )
    const broken = (async () => {
      throw new TypeError("network")
    }) as unknown as typeof fetch
    expect(await jev("k", template, "q", "bold", broken)).toBeNull()
    expect(JSON.parse(log.mock.calls.at(-1)?.[0] as string).error).toBe("fetch")
    // Waits for the abort the gate's own time limit sends.
    const slow = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason)
        )
      })) as unknown as typeof fetch
    const began = Date.now()
    expect(await jev("k", template, "q", "bold", slow)).toBeNull()
    expect(Date.now() - began).toBeLessThan(JEV.timeoutMs + 500)
    expect(JSON.parse(log.mock.calls.at(-1)?.[0] as string).error).toBe(
      "timeout"
    )
  })
})
