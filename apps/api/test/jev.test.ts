import { ADDRESS_ASK, addressReply } from "@workspace/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import replies from "../../../evals/typed-replies/replies.json" with {
  type: "json",
}
import {
  decisionOf,
  JEV,
  jev,
  jevApproval,
  jevAsksGoogle,
  jevBought,
  jevClaims,
  jevPromise,
  jevPutOn,
  jevReading,
  matched,
  phrased,
  readReply,
  verdictOf,
} from "../src/jev.ts"
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
      source: "jev",
    })
    expect(typeof line.ms).toBe("number")
  })

  it("sends Jev no secret-shaped string from the reply or the question", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const { fetchImpl, sent } = fake(answers(1, "answer", 1, ["modern", 1]))
    await jev(
      "k",
      template,
      "Which layout? postgres://db.internal/reme",
      "Modern, and my key is sk-fake12345678",
      fetchImpl
    )
    const body = JSON.parse(sent[0]?.init.body as string)
    expect(JSON.stringify(body)).not.toMatch(/sk-fake|db\.internal/)
    expect(body.state.owner_replied).toBe("Modern, and my key is [redacted]")
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

describe("the exact matcher", () => {
  afterEach(() => vi.restoreAllMocks())
  const font = choiceCard("font", o, () => "c4")

  it("takes a whole reply that is one option's label or id, in any case or punctuation", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    for (const reply of ["Bold", " bold. ", "BOLD!", "bold"]) {
      expect(matched(template, reply)).toEqual({
        kind: "answer",
        option: "bold",
      })
    }
    for (const reply of [
      "Clean sans",
      "clean_sans",
      "clean-sans",
      "Clean  Sans.",
    ]) {
      expect(matched(font, reply)).toEqual({
        kind: "answer",
        option: "clean_sans",
      })
    }
    expect(JSON.parse(log.mock.calls.at(-1)?.[0] as string)).toEqual({
      code: "onboarding.jev",
      step: "font",
      ms: 0,
      decision: "answer:clean_sans",
      error: null,
      cost_usd: null,
      source: "code",
    })
  })

  it("takes a plain deferral on any card Jev reads", () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    for (const card of [template, pages, contact]) {
      for (const reply of [
        "You pick",
        "up to you!",
        "Dealer's choice",
        "surprise me",
      ]) {
        expect(matched(card, reply)).toEqual({ kind: "defer" })
      }
    }
  })

  it("leaves every other reply to Jev, and logs nothing", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    for (const reply of [
      "yes but I also do carpets",
      "bold please",
      "the bold one",
      "bold or modern",
      "you pick, but not bold",
      "",
    ]) {
      expect(matched(template, reply)).toBeNull()
    }
    // A card that takes several reads its options with the planner.
    expect(matched(pages, "Home")).toBeNull()
    expect(matched(contact, "07700 900412")).toBeNull()
    expect(log).not.toHaveBeenCalled()
  })
})

const noul = (approves: number, declines: number, change: number) => ({
  answers: {
    approves: { type: "noul", noul: approves },
    declines: { type: "noul", noul: declines },
    asks_change: { type: "noul", noul: change },
  },
  usage: { cost: 0.00003 },
})

describe("a typed reply over an open card", () => {
  afterEach(() => vi.restoreAllMocks())

  it("reads only a whole phrase, in any case and punctuation", () => {
    for (const reply of [
      "yes",
      "Yes, please!",
      "  GO AHEAD. ",
      "Do it",
      "OK",
    ]) {
      expect(phrased(reply)).toBe("approve")
    }
    for (const reply of [
      "no",
      "Nope!",
      "No thanks.",
      "Don't",
      "don’t",
      "cancel",
      "STOP",
    ]) {
      expect(phrased(reply)).toBe("decline")
    }
    for (const reply of [
      "yes but make it 5pm",
      "yes, and add Sundays",
      "no wait",
      "ok then",
      "okay",
      "yes yes",
      "",
    ]) {
      expect(phrased(reply)).toBeNull()
    }
  })

  it("takes Jev's yes or no only when the deciding question is sure and the others are not", () => {
    expect(verdictOf(noul(0.97, 0.02, 0.03))).toBe("approve")
    expect(verdictOf(noul(0.02, 0.96, 0.01))).toBe("decline")
    // A change request wins over an approval, however sure the approval is.
    expect(verdictOf(noul(0.99, 0.01, 0.4))).toBeNull()
    expect(verdictOf(noul(0.99, 0.01, 0.11))).toBeNull()
    // It stops a decline only when it is sure: "nope, leave it" and "I don't
    // want that" scored 0.71 and 0.42 on it in the live run.
    expect(verdictOf(noul(0.03, 0.97, 0.71))).toBe("decline")
    expect(verdictOf(noul(0.01, 0.98, 0.42))).toBe("decline")
    expect(verdictOf(noul(0.02, 0.95, 0.9))).toBeNull()
    // And a decline still needs the approval to be unlikely.
    expect(verdictOf(noul(0.3, 0.97, 0.05))).toBeNull()
    // Unsure, or sure of both, or nothing in the body.
    expect(verdictOf(noul(0.85, 0.02, 0.02))).toBeNull()
    expect(verdictOf(noul(0.95, 0.95, 0.02))).toBeNull()
    expect(verdictOf({})).toBeNull()
  })

  it("asks Jev three noul questions in one call, scrubbed, and logs one line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const { fetchImpl, sent } = fake(noul(1, 0, 0))
    expect(
      await jevApproval(
        "k",
        "a reminder: Call the supplier",
        "sure, my key is sk-fake12345678",
        fetchImpl
      )
    ).toBe("approve")
    expect(sent).toHaveLength(1)
    const body = JSON.parse(sent[0]?.init.body as string)
    expect(body.model).toBe(JEV.model)
    expect(Object.keys(body.questions)).toEqual([
      "approves",
      "declines",
      "asks_change",
    ])
    for (const q of Object.values(body.questions) as { type: string }[]) {
      expect(q.type).toBe("noul")
    }
    expect(body.state.proposed_action).toBe("a reminder: Call the supplier")
    expect(body.state.owner_replied).toBe("sure, my key is [redacted]")
    expect(log).toHaveBeenCalledTimes(1)
    expect(JSON.parse(log.mock.calls[0]?.[0] as string)).toMatchObject({
      code: "approval.jev",
      verdict: "approve",
      error: null,
      cost_usd: 0.00003,
    })
  })

  it("leaves the reply to the normal turn on a non-200 or a failed fetch", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    expect(
      await jevApproval("k", "x", "yes", fake({ error: "x" }, 500).fetchImpl)
    ).toBeNull()
    expect(JSON.parse(log.mock.calls.at(-1)?.[0] as string).error).toBe(
      "status 500"
    )
    const broken = (async () => {
      throw new TypeError("network")
    }) as unknown as typeof fetch
    expect(await jevApproval("k", "x", "yes", broken)).toBeNull()
    expect(JSON.parse(log.mock.calls.at(-1)?.[0] as string).error).toBe("fetch")
  })

  it("sends all 40 recorded replies the way the label says, asking Jev only for those no phrase reads", async () => {
    const byReply = new Map(replies.replies.map((r) => [r.reply, r]))
    const asked: string[] = []
    // A Jev that is always right: this proves the plumbing, not Jev. The real
    // Jev's rate is `evals/typed-replies/measure.mjs`.
    const oracle = async (reply: string) => {
      asked.push(reply)
      const path = byReply.get(reply)?.path
      return path === "approve" || path === "decline" ? path : null
    }
    const counts = new Map<string, number>()
    for (const { reply, kind, path } of replies.replies) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1)
      expect((await readReply(reply, oracle)) ?? "normal", reply).toBe(path)
      // Nothing but a plain yes or no is ever a phrase.
      if (kind !== "plain") expect(phrased(reply), reply).toBeNull()
    }
    expect([...counts]).toEqual([
      ["yes_but", 10],
      ["plain", 10],
      ["unrelated", 10],
      ["borderline", 10],
    ])
    expect(asked.filter((reply) => phrased(reply))).toEqual([])
    expect(asked).toHaveLength(
      replies.replies.filter((r) => !phrased(r.reply)).length
    )
    // Jev down: only the phrases still answer.
    expect(await readReply("sure thing", null)).toBeNull()
    expect(
      await readReply("sure thing", async () => {
        throw new Error("down")
      })
    ).toBeNull()
  })
})

describe("the reading of a typed message", () => {
  afterEach(() => vi.restoreAllMocks())
  const read = (choice: string, confidence: number) =>
    fake({
      answers: { reading: { type: "choice", choice, confidence } },
      usage: { cost: 0.00002 },
    })
  const sentOf = (sent: { init: RequestInit }[]) =>
    JSON.parse(sent[0]?.init.body as string) as {
      state: Record<string, string>
      questions: { reading: { criteria: Record<string, string> } }
    }
  const asked = "Who should build your website?"

  it("names what a sure reading says the message does", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const answer = read("answer", 0.97)
    expect(await jevReading("k", asked, "you do it", answer.fetchImpl)).toBe(
      "answer"
    )
    expect(sentOf(answer.sent).state).toEqual({
      assistant_asked: asked,
      owner_said: "you do it",
    })
    const again = "I want to change it again"
    expect(
      await jevReading("k", asked, again, read("change", 0.95).fetchImpl)
    ).toBe("change")
    const price = "What do you charge?"
    expect(
      await jevReading("k", null, price, read("question", 0.93).fetchImpl)
    ).toBe("question")
  })

  it("offers no answer with no question waiting, and never takes one", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const { fetchImpl, sent } = read("answer", 0.99)
    expect(await jevReading("k", null, "Mostly couples", fetchImpl)).toBeNull()
    const body = sentOf(sent)
    expect(body.state).toEqual({ owner_said: "Mostly couples" })
    expect(Object.keys(body.questions.reading.criteria)).toEqual([
      "change",
      "question",
      "other",
    ])
  })

  it("reads as unsure below the bar, on other, or on a shape it does not know", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    for (const [choice, confidence] of [
      ["change", 0.6],
      ["other", 0.99],
      ["reschedule", 0.99],
    ] as const) {
      expect(
        await jevReading("k", asked, "hmm", read(choice, confidence).fetchImpl)
      ).toBeNull()
    }
    expect(await jevReading("k", asked, "hmm", fake({}).fetchImpl)).toBeNull()
  })

  it("reads as unsure on a non-200 or a slow answer, one log line each", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    expect(
      await jevReading("k", asked, "hmm", fake({ error: "x" }, 500).fetchImpl)
    ).toBeNull()
    expect(JSON.parse(log.mock.calls.at(-1)?.[0] as string)).toMatchObject({
      code: "reading.jev",
      reading: null,
      error: "status 500",
    })
    const slow = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason)
        )
      })) as unknown as typeof fetch
    expect(await jevReading("k", asked, "hmm", slow, 10)).toBeNull()
    expect(JSON.parse(log.mock.calls.at(-1)?.[0] as string).error).toBe(
      "timeout"
    )
    expect(log).toHaveBeenCalledTimes(2)
  })
})

describe("the reading of a reply that may promise work", () => {
  afterEach(() => vi.restoreAllMocks())
  const read = (acts: number, tells: number) =>
    fake({
      answers: {
        acts: { type: "noul", noul: acts },
        tells: { type: "noul", noul: tells },
      },
      usage: { cost: 0.00002 },
    })
  const never = async () => {
    throw new Error("watched was asked")
  }

  it("takes a sure promise of action without asking whether anything is watching", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const { fetchImpl, sent } = read(0.97, 0.05)
    expect(
      await jevPromise("k", "I'll set that up now.", never, fetchImpl)
    ).toBe(true)
    expect(JSON.parse(sent[0]?.init.body as string).state).toEqual({
      assistant_said: "I'll set that up now.",
    })
  })

  it("takes a promise to tell the owner later only when nothing is watching", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const said = "I'll tell you when it's live."
    expect(
      await jevPromise("k", said, async () => false, read(0.1, 0.98).fetchImpl)
    ).toBe(true)
    expect(
      await jevPromise("k", said, async () => true, read(0.1, 0.98).fetchImpl)
    ).toBe(false)
  })

  it("leaves an honest ending, an unsure reading and a failed call alone", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    expect(
      await jevPromise("k", "Done.", never, read(0.03, 0.03).fetchImpl)
    ).toBe(false)
    expect(
      await jevPromise("k", "Hmm.", never, read(0.77, 0.6).fetchImpl)
    ).toBe(false)
    expect(await jevPromise("k", "Hmm.", never, fake({}, 500).fetchImpl)).toBe(
      false
    )
  })
})

describe("the reading of a reply that may state a detail it was not shown", () => {
  afterEach(() => vi.restoreAllMocks())
  const read = (score: number, status = 200) =>
    fake({ answers: { invents: { type: "noul", noul: score } } }, status)

  it("is sure only at the bar, sends the reply and what was shown as data, and passes a failed call", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const said = "An oven clean is £45."
    const sure = read(0.96)
    expect(
      await jevClaims("k", said, "Regular clean £60", sure.fetchImpl)
    ).toBe(true)
    expect(JSON.parse(sure.sent[0]?.init.body as string).state).toEqual({
      assistant_said: said,
      shown: "Regular clean £60",
    })
    expect(await jevClaims("k", said, "", read(0.6).fetchImpl)).toBe(false)
    expect(await jevClaims("k", said, "", read(0.99, 500).fetchImpl)).toBe(
      false
    )
  })
})

describe("the reading of a message that may put the site on a name", () => {
  afterEach(() => vi.restoreAllMocks())
  const read = (score: number) =>
    fake({ answers: { yes: { type: "noul", noul: score } } })

  it("is sure only at the bar, and sends the message and the name as data", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const said = "Put the site on sparkleclean.co.uk"
    const sure = read(0.95)
    expect(
      await jevPutOn("k", said, "sparkleclean.co.uk", sure.fetchImpl)
    ).toBe(true)
    expect(JSON.parse(sure.sent[0]?.init.body as string).state).toEqual({
      owner_said: said,
      domain: "sparkleclean.co.uk",
    })
    expect(
      await jevPutOn("k", said, "sparkleclean.co.uk", read(0.89).fetchImpl)
    ).toBe(false)
  })

  it("takes the tray's own yes with no reading, and never reads a message without the name", async () => {
    const name = "sparkleclean.co.uk"
    const never = fake({}, 500)
    expect(
      await jevPutOn(
        "k",
        addressReply(ADDRESS_ASK.yes, name) ?? "",
        name,
        never.fetchImpl
      )
    ).toBe(true)
    expect(
      await jevPutOn(
        "k",
        "Yes, it's sparkleclean.com",
        name,
        read(0.99).fetchImpl
      )
    ).toBe(false)
    expect(never.sent).toHaveLength(0)
  })

  it("reads only a whole name, so a longer or lookalike name is never the one named", async () => {
    const name = "sparkleclean.co.uk"
    const sure = read(0.99)
    for (const said of [
      "Put it on notsparkleclean.co.uk",
      "Put it on sparkleclean.co.uk.example.com",
      "Put it on sparkleclean.co.ukx",
      "Put it on sparklecleanXco.uk",
    ]) {
      expect(await jevPutOn("k", said, name, sure.fetchImpl)).toBe(false)
    }
    expect(sure.sent).toHaveLength(0)
    for (const said of [
      "Put it on sparkleclean.co.uk.",
      "Put it on www.SparkleClean.co.uk, please",
    ]) {
      expect(await jevPutOn("k", said, name, sure.fetchImpl)).toBe(true)
    }
  })

  it("reads as no on a non-200, a missing answer and the time limit, one log line each", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const slow = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason)
        )
      })) as unknown as typeof fetch
    for (const fetchImpl of [
      fake({}, 500).fetchImpl,
      fake({}).fetchImpl,
      slow,
    ]) {
      expect(
        await jevPutOn("k", "put it on a.co.uk", "a.co.uk", fetchImpl, 10)
      ).toBe(false)
    }
    expect(log).toHaveBeenCalledTimes(3)
    expect(JSON.parse(log.mock.calls.at(-1)?.[0] as string)).toMatchObject({
      code: "put_on.jev",
      sure: false,
      error: "timeout",
    })
  })
})

describe("the reading of a message that says a domain is bought", () => {
  afterEach(() => vi.restoreAllMocks())
  const read = (score: number) =>
    fake({ answers: { yes: { type: "noul", noul: score } } })

  it("is sure only at the bar, and sends the message and the name as data", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const sure = read(0.96)
    expect(
      await jevBought(
        "k",
        "done, I bought it",
        "sparkleclean.co.uk",
        sure.fetchImpl
      )
    ).toBe(true)
    expect(JSON.parse(sure.sent[0]?.init.body as string).state).toEqual({
      owner_said: "done, I bought it",
      domain: "sparkleclean.co.uk",
    })
    expect(
      await jevBought(
        "k",
        "I'll buy it tonight",
        "a.co.uk",
        read(0.2).fetchImpl
      )
    ).toBe(false)
    expect(
      await jevBought("k", "done", "a.co.uk", fake({}, 500).fetchImpl)
    ).toBe(false)
  })
})

describe("the reading of a message that asks for Google before a domain", () => {
  afterEach(() => vi.restoreAllMocks())
  const read = (score: number) =>
    fake({ answers: { yes: { type: "noul", noul: score } } })

  it("reads only a message naming Google or search, with no domain sent", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const unread = read(0.99)
    expect(
      await jevAsksGoogle("k", "can you add my prices?", unread.fetchImpl)
    ).toBe(false)
    expect(unread.sent).toHaveLength(0)
    const sure = read(0.96)
    expect(
      await jevAsksGoogle("k", "Connect Google to my site", sure.fetchImpl)
    ).toBe(true)
    expect(JSON.parse(sure.sent[0]?.init.body as string).state).toEqual({
      owner_said: "Connect Google to my site",
    })
    expect(
      await jevAsksGoogle("k", "reply to my Google review", read(0.1).fetchImpl)
    ).toBe(false)
    expect(
      await jevAsksGoogle("k", "get me on Google", fake({}, 500).fetchImpl)
    ).toBe(false)
  })
})
