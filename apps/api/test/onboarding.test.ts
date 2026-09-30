import {
  AskChoiceInput,
  type FactValue,
  INDUSTRIES,
  TONES,
  type ToneId,
} from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import type { ToolPart } from "../src/chat.ts"
import {
  applied,
  built,
  cardAnswer,
  chosen,
  ONBOARDING_GOAL,
  type Onboarding,
  onboardingStep,
  opening,
  progressOf,
  STEPS,
  type StepId,
  stepOf,
  typedAnswer,
  voiceOf,
} from "../src/onboarding.ts"
import {
  manualEnd,
  opener,
  photos,
  question,
  started,
  type Voice,
} from "../src/onboarding-copy.ts"

const counter = () => {
  let n = 0
  return () => `id${++n}`
}

const BUSINESS = "Brightclean (fixture)"
const ORG = "0f1e2d3c-4b5a-4968-8776-655443322110"

const start = (over: Partial<Onboarding> = {}): Onboarding => ({
  orgId: ORG,
  facts: [{ key: "business.name", value: { name: BUSINESS } }],
  passed: [],
  offered: false,
  builder: null,
  orgName: BUSINESS,
  ownerName: "Probe Owner",
  ...over,
})

/** The answer an owner gives each card, as the web would send it. */
const FACTS: Partial<Record<StepId, FactValue>> = {
  "business.offerings": {
    key: "business.offerings",
    value: { items: ["Regular cleaning", "Deep cleans"] },
  },
  "business.audience": {
    key: "business.audience",
    value: { text: "Busy families nearby." },
  },
  "business.overview": {
    key: "business.overview",
    value: { text: "We visit, quote, then clean weekly." },
  },
  "service_area.text": {
    key: "service_area.text",
    value: { text: "Fictional Town and villages" },
  },
  "business.phone": { key: "business.phone", value: { e164: "+441632960001" } },
  "business.email": {
    key: "business.email",
    value: { address: "hello@brightclean.invalid" },
  },
  "assistant.name": { key: "assistant.name", value: { name: "Maya" } },
  "owner.preferred_name": {
    key: "owner.preferred_name",
    value: { name: "Sam" },
  },
}
const CHOSEN: Partial<Record<StepId, string[]>> = {
  industry: ["cleaning"],
  pronouns: ["she_her"],
  tone: ["friendly"],
  build_for_me: ["yes"],
  template: ["classic"],
  palette: ["ocean"],
  font: ["clean_sans"],
  pages: ["services"],
}

/** Answers every card the way `answers` says, and names the steps asked. */
function walk(o: Onboarding, answers: (card: ToolPart) => unknown) {
  const asked: StepId[] = []
  let at = o
  for (let i = 0; i < 40; i++) {
    const step = onboardingStep(at, counter())
    const card = step.find((p): p is ToolPart => p.type.startsWith("tool-"))
    if (!card) return { asked, at, step }
    const id = card.type === "tool-request_change" ? "build" : stepOf(card)
    asked.push(id as StepId)
    if (id === "build") return { asked, at, step }
    const answer = cardAnswer(card, answers(card), [])
    if (!answer) throw new Error(`refused ${id}`)
    at = applied(at, answer)
  }
  throw new Error("the script did not end")
}

const everyCard = (card: ToolPart): unknown => {
  const step = stepOf(card) as StepId
  if (card.type === "tool-ask_upload") return { answer: "skipped" }
  if (card.type === "tool-ask_choice") {
    return { answer: "chosen", ids: CHOSEN[step], other: null }
  }
  const fact = FACTS[step]
  return fact ? { answer: "stated", fact } : { answer: "skipped" }
}

describe("the onboarding steps", () => {
  it("asks the five phases in order, then starts the build", () => {
    const { asked, step } = walk(start(), everyCard)
    expect(asked).toEqual([
      "industry",
      "business.offerings",
      "business.audience",
      "business.overview",
      "service_area.text",
      "business.phone",
      "business.email",
      "business.tagline",
      "assistant.name",
      "pronouns",
      "tone",
      "owner.preferred_name",
      "build_for_me",
      "template",
      "palette",
      "font",
      "pages",
      "upload",
      "build",
    ])
    expect(step).toEqual([
      {
        type: "tool-request_change",
        toolCallId: "id1",
        state: "input-available",
        input: { text: ONBOARDING_GOAL },
      },
    ])
  })

  it("makes every step a question and one card", () => {
    let at = start()
    for (let i = 1; i < STEPS.length - 1; i++) {
      const step = onboardingStep(at, counter())
      if (step[0]?.type === "tool-request_change") break
      const [text, card, ...rest] = step
      expect(rest).toEqual([])
      expect(text).toMatchObject({ type: "text", state: "done" })
      expect(card?.type).toMatch(/^tool-ask_/)
      const answer = cardAnswer(
        card as ToolPart,
        everyCard(card as ToolPart),
        []
      )
      if (!answer) break
      at = applied(at, answer)
    }
  })

  it("reads stored fact rows, provenance and all", () => {
    const row = {
      key: "assistant.tone",
      value: { id: "casual" },
      provenance: { source: "owner_stated" },
    }
    expect(voiceOf(start({ facts: [row] })).tone).toBe("casual")
  })

  it("asks a returning owner only for what is missing", () => {
    const held = start({
      facts: [
        { key: "business.name", value: { name: BUSINESS } },
        FACTS["business.phone"] as FactValue,
        FACTS["business.email"] as FactValue,
        { key: "business.tagline", value: { tagline: "Fresh homes" } },
      ],
    })
    const { asked } = walk(held, everyCard)
    expect(asked).not.toContain("business.phone")
    expect(asked).not.toContain("business.email")
    expect(asked).not.toContain("business.tagline")
    expect(asked[0]).toBe("industry")
  })

  it("asks the business name first when sign-up gave none, filled in from the org", () => {
    const [, card] = onboardingStep(start({ facts: [] }), counter())
    expect((card as ToolPart).input).toEqual({
      key: "business.name",
      skippable: false,
      prefill: { name: BUSINESS },
    })
  })

  it("fills in what the assistant calls the owner from the session", () => {
    expect(cardFor("owner.preferred_name").input).toEqual({
      key: "owner.preferred_name",
      skippable: false,
      prefill: { name: "Probe Owner" },
    })
  })

  it("takes the Skip branch: build mode manual, the builder question, then a closing line", () => {
    const { asked, step } = walk(start(), (card) =>
      stepOf(card) === "build_for_me"
        ? { answer: "chosen", ids: ["skip"], other: null }
        : stepOf(card) === "manual_builder"
          ? { answer: "chosen", ids: ["no"], other: null }
          : everyCard(card)
    )
    expect(asked.slice(-2)).toEqual(["build_for_me", "manual_builder"])
    expect(step).toEqual([
      expect.objectContaining({ type: "text", text: expect.any(String) }),
    ])
    expect(step).toHaveLength(1)
  })

  it("labels the build card's no as Skip, and the builder card's plainly", () => {
    const labels = (at: Onboarding) =>
      AskChoiceInput.parse(
        (onboardingStep(at, counter())[1] as ToolPart).input
      ).options.map((o) => o.label)
    const facts = [
      { key: "business.name", value: { name: BUSINESS } },
      ...Object.values(FACTS),
      { key: "business.industry", value: { name: "x", category: null } },
      { key: "business.tagline", value: { tagline: "x" } },
      { key: "assistant.pronouns", value: { id: "she_her" } },
      { key: "assistant.tone", value: { id: "friendly" } },
    ] as FactValue[]
    expect(labels(start({ facts }))).toEqual(["Yes, build it for me", "Skip"])
    expect(
      labels(
        start({
          facts: [
            ...facts,
            { key: "site.build_mode", value: { mode: "manual" } },
          ],
        })
      )
    ).toEqual(["Yes", "No"])
  })

  it("resolves the build card, then closes in a step of its own so no client sends again", () => {
    const o = start()
    const pending: ToolPart = {
      type: "tool-request_change",
      toolCallId: "c1",
      state: "input-available",
      input: { text: ONBOARDING_GOAL },
    }
    const build = {
      assignment_id: ORG,
      kind: "site.build" as const,
      state: "queued" as const,
      goal: ONBOARDING_GOAL,
      revision: null,
      created_at: "2026-09-26T09:30:00.000Z",
      updated_at: "2026-09-26T09:30:00.000Z",
    }
    const ok = built(o, pending, { outcome: "started", build })
    expect(ok.slice(0, 2)).toEqual([
      {
        ...pending,
        state: "output-available",
        output: { outcome: "started", build },
      },
      { type: "step-start" },
    ])
    expect((ok[2] as { text: string }).text).toContain(BUSINESS)
    const refused = built(o, pending, {
      outcome: "refused",
      error: { class: "validation", code: "change.build_busy", message: "x" },
    })
    expect((refused[2] as { text: string }).text).toMatch(/couldn't start/)
  })
})

/** Every fact the walk states, choices included. */
const ALL: FactValue[] = [
  { key: "business.name", value: { name: BUSINESS } },
  { key: "business.industry", value: { name: "x", category: null } },
  ...(Object.values(FACTS) as FactValue[]),
  { key: "business.tagline", value: { tagline: "x" } },
  { key: "assistant.pronouns", value: { id: "she_her" } },
  { key: "assistant.tone", value: { id: "friendly" } },
  { key: "site.build_mode", value: { mode: "assistant" } },
  { key: "site.template", value: { id: "classic" } },
  { key: "site.palette", value: { id: "ocean" } },
  { key: "site.font", value: { id: "clean_sans" } },
  { key: "site.pages", value: { ids: ["home", "quote"] } },
]

const KEY: Partial<Record<StepId, string>> = {
  industry: "business.industry",
  pronouns: "assistant.pronouns",
  tone: "assistant.tone",
  build_for_me: "site.build_mode",
  template: "site.template",
  palette: "site.palette",
  font: "site.font",
  pages: "site.pages",
}

/** The card the api makes for `step`, with every earlier step's fact held. */
function cardFor(step: StepId): ToolPart {
  const order = STEPS.map((s) => s.id)
  const before = new Set(
    order.slice(0, order.indexOf(step)).map((id) => KEY[id] ?? id)
  )
  const at = start({ facts: ALL.filter((f) => before.has(f.key)) })
  const card = onboardingStep(at, counter()).find((p) =>
    p.type.startsWith("tool-")
  ) as ToolPart
  expect(stepOf(card)).toBe(step)
  return card
}

describe("an answer on a card", () => {
  it("refuses an id the card did not offer, two where one is asked, and nothing at all", () => {
    const card = cardFor("pronouns")
    for (const output of [
      { answer: "chosen", ids: ["it_its"], other: null },
      { answer: "chosen", ids: ["he_him", "she_her"], other: null },
      { answer: "chosen", ids: [], other: null },
      { answer: "chosen", ids: [], other: "xe/xem" },
      { answer: "skipped" },
    ]) {
      expect(cardAnswer(card, output, [])).toBeNull()
    }
    expect(
      cardAnswer(card, { answer: "chosen", ids: ["she_her"], other: null }, [])
    ).toEqual({
      kind: "facts",
      facts: [{ key: "assistant.pronouns", value: { id: "she_her" } }],
    })
  })

  it("keeps the owner's own words: an industry with no category, a custom palette, the closest template", () => {
    const words = (step: StepId, other: string) =>
      cardAnswer(cardFor(step), { answer: "chosen", ids: [], other }, [])
    expect(words("industry", "Dog grooming")).toEqual({
      kind: "facts",
      facts: [
        {
          key: "business.industry",
          value: { name: "Dog grooming", category: null },
        },
      ],
    })
    expect(words("palette", "Navy and gold")).toMatchObject({
      facts: [{ value: { id: "custom", custom: "Navy and gold" } }],
    })
    expect(words("template", "Dark and striking")).toMatchObject({
      facts: [{ value: { id: "bold", custom: "Dark and striking" } }],
    })
    expect(words("template", "Something like my old flyer")).toMatchObject({
      facts: [{ value: { id: "classic" } }],
    })
  })

  it("always adds the fixed pages, in the list's order", () => {
    expect(
      cardAnswer(
        cardFor("pages"),
        { answer: "chosen", ids: ["gallery", "about"], other: null },
        []
      )
    ).toMatchObject({
      facts: [{ value: { ids: ["home", "about", "gallery", "quote"] } }],
    })
  })

  it("skips only the tagline among the facts, and takes only photos the org holds", () => {
    expect(
      cardAnswer(cardFor("business.phone"), { answer: "skipped" }, [])
    ).toBeNull()
    expect(
      cardAnswer(cardFor("business.tagline"), { answer: "skipped" }, [])
    ).toEqual({ kind: "passed", step: "business.tagline" })
    const upload = cardFor("upload")
    const asset = {
      id: "3f2b9c1e-8a4d-4f6b-9c2a-1d5e7f8a9b0c",
      name: "van.jpg",
      content_type: "image/jpeg",
      bytes: 1000,
    }
    const sent = { answer: "uploaded", assets: [asset] }
    expect(cardAnswer(upload, sent, [])).toBeNull()
    expect(cardAnswer(upload, sent, [asset])).toEqual({
      kind: "passed",
      step: "upload",
    })
    expect(cardAnswer(upload, { answer: "skipped" }, [])).toEqual({
      kind: "passed",
      step: "upload",
    })
  })

  it("refuses a fact for another key than the card's", () => {
    expect(
      cardAnswer(
        cardFor("business.phone"),
        { answer: "stated", fact: FACTS["business.email"] },
        []
      )
    ).toBeNull()
  })

  it("checks a choice's ids against the contracts' lists", () => {
    const input = AskChoiceInput.parse({
      ...(cardFor("industry").input as object),
      options: [
        { id: "moon", label: "Moon", hint: null, visual: null },
        {
          id: "cleaning",
          label: "Cleaning",
          hint: null,
          visual: null,
        },
      ],
    })
    expect(chosen(input, ["moon"], null)).toBeNull()
  })
})

describe("a typed reply", () => {
  const facts = (step: StepId, words: string) =>
    typedAnswer(cardFor(step), words)

  it("takes the words as a text ask's value, a phone number as E.164", () => {
    expect(facts("business.phone", "+44 (1632) 960-001")).toEqual({
      kind: "facts",
      facts: [{ key: "business.phone", value: { e164: "+441632960001" } }],
    })
    expect(facts("business.phone", "0044 1632 960001")).toMatchObject({
      facts: [{ value: { e164: "+441632960001" } }],
    })
    expect(
      facts("business.offerings", "Regular cleaning, deep cleans and ovens")
    ).toMatchObject({
      facts: [
        { value: { items: ["Regular cleaning", "deep cleans and ovens"] } },
      ],
    })
    expect(facts("assistant.name", "  Maya ")).toMatchObject({
      facts: [{ value: { name: "Maya" } }],
    })
  })

  it("asks again with a specific line when the words do not fit", () => {
    expect(facts("business.phone", "01632 960001")).toEqual({
      kind: "retry",
      reason: "phone",
    })
    expect(facts("business.email", "hello at brightclean")).toEqual({
      kind: "retry",
      reason: "email",
    })
    expect(facts("assistant.name", "x".repeat(100))).toEqual({
      kind: "retry",
      reason: "long",
    })
  })

  it("matches a choice by label or id, and takes the owner's words where the card has an Other", () => {
    expect(facts("pronouns", "She/Her.")).toMatchObject({
      facts: [{ value: { id: "she_her" } }],
    })
    expect(facts("pronouns", "they")).toMatchObject({
      facts: [{ value: { id: "they_them" } }],
    })
    expect(facts("tone", "PROFESSIONAL")).toMatchObject({
      facts: [{ value: { id: "professional" } }],
    })
    expect(facts("pronouns", "whatever")).toEqual({
      kind: "retry",
      reason: "choice",
    })
    expect(facts("industry", "Dog grooming")).toMatchObject({
      facts: [{ value: { name: "Dog grooming", category: null } }],
    })
    expect(facts("industry", "legal and consultancy")).toMatchObject({
      facts: [{ value: { category: "legal" } }],
    })
    expect(facts("pages", "About, gallery and a blog")).toMatchObject({
      facts: [
        {
          value: {
            ids: ["home", "about", "gallery", "quote"],
            custom: "a blog",
          },
        },
      ],
    })
  })

  it("reads yes and no in the owner's own words", () => {
    expect(facts("build_for_me", "Sure, go for it")).toMatchObject({
      facts: [{ value: { mode: "assistant" } }],
    })
    expect(facts("build_for_me", "nope")).toMatchObject({
      facts: [{ value: { mode: "manual" } }],
    })
    expect(facts("build_for_me", "hmm")).toEqual({
      kind: "retry",
      reason: "yes_no",
    })
  })

  it("skips the photos and the tagline, and asks again for anything else on the photo card", () => {
    expect(facts("upload", "I don't have any")).toEqual({
      kind: "passed",
      step: "upload",
    })
    expect(facts("upload", "here you go")).toEqual({
      kind: "retry",
      reason: "upload",
    })
    expect(facts("business.tagline", "skip")).toEqual({
      kind: "passed",
      step: "business.tagline",
    })
    expect(
      facts("business.tagline", "Fresh homes, happy people")
    ).toMatchObject({
      facts: [{ value: { tagline: "Fresh homes, happy people" } }],
    })
  })
})

describe("the progress a conversation's cards hold", () => {
  const row = (over: Record<string, unknown>) => ({
    type: "tool-ask_fact",
    state: "output-available",
    step: null,
    answer: null,
    choice: null,
    reply: null,
    ...over,
  })

  it("counts skips, photos and the builder answer, typed or clicked", () => {
    expect(
      progressOf([
        row({ step: "business.tagline", answer: "skipped" }),
        row({
          type: "tool-ask_upload",
          state: "output-error",
          reply: "No thanks",
        }),
        row({
          type: "tool-ask_choice",
          step: "manual_builder",
          state: "output-error",
          reply: "nope",
        }),
      ])
    ).toEqual({
      passed: ["business.tagline", "upload"],
      offered: false,
      builder: false,
    })
    expect(
      progressOf([
        row({
          type: "tool-ask_choice",
          step: "manual_builder",
          answer: "chosen",
          choice: "yes",
        }),
      ]).builder
    ).toBe(true)
  })

  it("counts a started build, and not one talked over", () => {
    expect(
      progressOf([row({ type: "tool-request_change", state: "output-error" })])
        .offered
    ).toBe(false)
    expect(progressOf([row({ type: "tool-request_change" })]).offered).toBe(
      true
    )
  })

  it("does not count a typed answer that was not a skip", () => {
    expect(
      progressOf([
        row({ type: "tool-ask_upload", state: "output-error", reply: "soon" }),
        row({ step: "business.phone", state: "output-error", reply: "no" }),
      ]).passed
    ).toEqual([])
  })
})

/** Many org ids, so every wording of every line comes up. */
const ORGS = Array.from(
  { length: 60 },
  (_, i) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`
)

const voice = (over: Partial<Voice> = {}): Voice => ({
  org: ORG,
  business: BUSINESS,
  owner: "Sam",
  assistant: "Maya",
  pronouns: "she_her",
  tone: "friendly",
  industry: { name: "Cleaning and home services", category: "cleaning" },
  offering: "Regular cleaning",
  template: "Classic",
  palette: "Ocean",
  ...over,
})

const INDUSTRY_VOICES = [
  ...INDUSTRIES.map((i) => ({ name: i.label, category: i.id })),
  { name: "Dog grooming", category: null },
]

/** Every line the script can say for `v`, by name. */
const lines = (v: Voice): [string, string][] => [
  ["opener", opener(v)],
  ...(
    STEPS.map((s) => s.id).filter(
      (id) => id !== "upload" && id !== "build"
    ) as Exclude<StepId, "upload" | "build">[]
  ).map((id): [string, string] => [id, question(id, v)]),
  ["upload", photos(v)],
  ["started", started(v, true)],
  ["manual_yes", manualEnd(v, true)],
  ["manual_no", manualEnd(v, false)],
]

/** The lines that name the business in every wording. */
const NAMED = ["opener", "industry", "assistant.name", "upload", "started"]

describe("the onboarding copy", () => {
  it("never uses an em dash, a price, a currency or a tier, and names the business where it should", () => {
    for (const org of ORGS) {
      for (const industry of INDUSTRY_VOICES) {
        for (const { id: tone } of TONES) {
          for (const [name, text] of lines(voice({ org, industry, tone }))) {
            expect(text, name).not.toMatch(/[—–]/)
            expect(text, name).not.toMatch(
              /[$£€]|\bprices?\b|\bpricing\b|\btiers?\b/i
            )
            expect(text, name).not.toMatch(/\d+\s*(?:an hour|per hour|\/h)/i)
            expect(text, name).not.toMatch(/\(s?he\/|\(they\//)
            if (NAMED.includes(name)) expect(text, name).toContain(BUSINESS)
            if (tone === "professional") expect(text, name).not.toContain("!")
          }
        }
      }
    }
  })

  it("keeps one org's wording on every call, and varies it across orgs", () => {
    const once = lines(voice())
    expect(lines(voice())).toEqual(once)
    for (const name of [
      "opener",
      "assistant.name",
      "build_for_me",
      "upload",
      "started",
      "business.phone",
      "business.email",
      "business.audience",
    ]) {
      const seen = new Set(
        ORGS.map((org) => lines(voice({ org })).find(([n]) => n === name)?.[1])
      )
      expect(seen.size, name).toBeGreaterThanOrEqual(2)
    }
  })

  it("asks about photos three ways for each industry, and names an Other industry and its first service", () => {
    for (const industry of INDUSTRY_VOICES) {
      const asked = new Set(ORGS.map((org) => photos(voice({ org, industry }))))
      expect(asked.size, industry.name).toBeGreaterThanOrEqual(3)
    }
    const other = ORGS.map((org) =>
      photos(
        voice({
          org,
          industry: { name: "Dog grooming", category: null },
          offering: "Full grooms",
        })
      )
    ).join("\n")
    expect(other).toContain("dog grooming work")
    expect(other).toContain("full grooms")
  })

  it("mentions the quote page when it turns to the website", () => {
    for (const org of ORGS) {
      expect(question("build_for_me", voice({ org }))).toContain(
        "Request a quote"
      )
      expect(question("build_for_me", voice({ org }))).toContain(
        "Would you like Maya to build your website for you?"
      )
    }
  })

  it("speaks of the draft in the first person, whatever the pronouns", () => {
    for (const org of ORGS) {
      for (const pronouns of ["he_him", "she_her", "they_them"] as const) {
        const text = question("build_for_me", voice({ org, pronouns }))
        expect(text).toContain("I can have a first draft ready")
        expect(text).not.toMatch(/\b(He|She|They) can have\b/)
      }
    }
  })

  it("adjusts the tone: no exclamation marks when professional, contractions when casual", () => {
    const at = (tone: ToneId) =>
      ORGS.map((org) => question("build_for_me", voice({ org, tone }))).join(
        "\n"
      )
    expect(at("friendly")).toContain("!")
    expect(at("professional")).not.toContain("!")
    expect(at("professional")).not.toMatch(/\bI'm\b|\bit's\b/i)
    expect(at("casual")).toMatch(/\bWant Maya to build\b/)
  })

  it("opens the first row with an opener and the first question together", () => {
    const [text, card] = opening(start(), counter())
    expect((text as { text: string }).text).toContain(opener(voiceOf(start())))
    expect((text as { text: string }).text).toContain(
      question("industry", voiceOf(start()))
    )
    expect(stepOf(card as ToolPart)).toBe("industry")
  })
})
