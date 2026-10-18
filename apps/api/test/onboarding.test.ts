import {
  AskChoiceInput,
  AskDesignInput,
  AskDetailsInput,
  type FactValue,
  FONT_PAIRS,
  INDUSTRIES,
  PALETTES,
  PaletteId,
  TONES,
  type ToneId,
} from "@workspace/contracts"
import DIRECTIONS from "@workspace/starter-site/directions.json"
import { describe, expect, it } from "vitest"
import type { ToolPart } from "../src/chat.ts"
import {
  applied,
  built,
  cardAnswer,
  choiceCard,
  chosen,
  currentStep,
  DEFAULT_QUOTE_FIELDS,
  decided,
  designAnswer,
  designDone,
  factCard,
  firstPalettes,
  ONBOARDING_GOAL,
  type Onboarding,
  onboardingStep,
  openCard,
  opening,
  pagesNamed,
  progressOf,
  STEPS,
  type StepId,
  stepOf,
  typedAnswer,
  voiceOf,
  withChoice,
} from "../src/onboarding.ts"
import {
  manualEnd,
  opener,
  photos,
  question,
  quoteForm,
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
  closed: [],
  offered: false,
  builder: null,
  orgName: BUSINESS,
  ownerName: "Probe Owner",
  ownerEmail: "probe@brightclean.invalid",
  ...over,
})

const PHONE = {
  key: "business.phone",
  value: { e164: "+441632960001" },
} as const satisfies FactValue
const EMAIL = {
  key: "business.email",
  value: { address: "hello@brightclean.invalid" },
} as const satisfies FactValue
const QUOTE = {
  key: "quote.form",
  value: { fields: [...DEFAULT_QUOTE_FIELDS] },
} as const satisfies FactValue

/** The answer an owner gives each form or details card, as the web would send it. */
const FACTS: Partial<Record<StepId, FactValue[]>> = {
  "business.offerings": [
    {
      key: "business.offerings",
      value: { items: ["Regular cleaning", "Deep cleans"] },
    },
  ],
  "business.audience": [
    { key: "business.audience", value: { text: "Busy families nearby." } },
  ],
  "business.proof": [
    {
      key: "business.proof",
      value: { text: "Ten years trading, fully insured." },
    },
  ],
  "service_area.text": [
    {
      key: "service_area.text",
      value: { text: "Fictional Town and villages" },
    },
  ],
  contact: [PHONE, EMAIL],
  assistant: [
    { key: "assistant.name", value: { name: "Maya" } },
    { key: "assistant.pronouns", value: { id: "she_her" } },
    { key: "assistant.tone", value: { id: "friendly" } },
  ],
  "owner.preferred_name": [
    { key: "owner.preferred_name", value: { name: "Sam" } },
  ],
}
const CHOSEN: Partial<Record<StepId, string[]>> = {
  industry: ["cleaning"],
  build_for_me: ["yes"],
  template: ["classic"],
  palette: ["ocean"],
  font: ["clean_sans"],
  pages: ["services"],
}

/**
 * Answers every card the way `answers` says, and names the steps asked. The
 * quote question is asked in words, so the walk states the form the
 * planner's proposal would have, as an owner confirming it.
 */
function walk(o: Onboarding, answers: (card: ToolPart) => unknown) {
  const asked: StepId[] = []
  let at = o
  for (let i = 0; i < 40; i++) {
    const step = onboardingStep(at, counter())
    const card = step.find((p): p is ToolPart => p.type.startsWith("tool-"))
    if (!card && currentStep(at)?.id === "quote_form") {
      asked.push("quote_form")
      at = applied(at, { kind: "facts", facts: [QUOTE] })
      continue
    }
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
  if (card.type === "tool-ask_design") {
    const { questions } = AskDesignInput.parse(card.input)
    return {
      answers: Object.fromEntries(
        questions.map((q) => {
          const first = q.card.options[0]?.id
          return [
            q.id,
            q.card.multiple ? { choices: [first] } : { choice: first },
          ]
        })
      ),
      skip_all: false,
    }
  }
  if (card.type === "tool-ask_choice") {
    return { answer: "chosen", ids: CHOSEN[step], other: null }
  }
  const facts = FACTS[step]
  if (card.type === "tool-ask_details") return { answer: "stated", facts }
  return facts ? { answer: "stated", fact: facts[0] } : { answer: "skipped" }
}

describe("the onboarding steps", () => {
  it("asks the five phases in order, then starts the build", () => {
    const { asked, step } = walk(start(), everyCard)
    expect(asked).toEqual([
      "business.offerings",
      "service_area.text",
      "business.audience",
      "business.proof",
      "industry",
      "contact",
      "assistant",
      "owner.preferred_name",
      "build_for_me",
      "design",
      "quote_form",
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

  it("makes every card step a question and one card, and asks the quote in words", () => {
    let at = start()
    for (let i = 1; i < STEPS.length; i++) {
      const step = onboardingStep(at, counter())
      if (step[0]?.type === "tool-request_change") break
      if (currentStep(at)?.id === "quote_form") {
        expect(step).toEqual([
          expect.objectContaining({ type: "text", state: "done" }),
        ])
        at = applied(at, { kind: "facts", facts: [QUOTE] })
        continue
      }
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

  it("never starts a build before the quote form is confirmed or declined, and the photos after it", () => {
    const { asked, at } = walk(start(), everyCard)
    expect(asked.slice(-3)).toEqual(["quote_form", "upload", "build"])
    // Asked for changes: the question comes back before any build.
    const changed = applied(
      { ...at, facts: at.facts.filter((f) => f.key !== "quote.form") },
      { kind: "facts", facts: [] }
    )
    expect(currentStep(changed)?.id).toBe("quote_form")
    // Declined: the card closed with no fact, and the default form stands.
    expect(
      onboardingStep(
        { ...changed, closed: [...changed.closed, "quote_form"] },
        counter()
      )[0]
    ).toMatchObject({ type: "tool-request_change" })
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
        PHONE,
        EMAIL,
        { key: "business.industry", value: { name: "x", category: null } },
      ],
    })
    const { asked } = walk(held, everyCard)
    expect(asked).not.toContain("contact")
    expect(asked).not.toContain("industry")
    expect(asked[0]).toBe("business.offerings")
  })

  it("asks the contact details on one card, half held or none", () => {
    const card = cardFor("contact")
    expect(AskDetailsInput.parse(card.input)).toEqual({
      step: "contact",
      prefill: [
        {
          key: "business.email",
          value: { address: "probe@brightclean.invalid" },
        },
      ],
      skippable: false,
    })
    const half = start({ facts: [...ALL_BEFORE("contact"), PHONE] })
    expect(currentStep(half)?.id).toBe("contact")
    expect(
      AskDetailsInput.parse(
        (onboardingStep(half, counter())[1] as ToolPart).input
      ).prefill
    ).toEqual([
      PHONE,
      {
        key: "business.email",
        value: { address: "probe@brightclean.invalid" },
      },
    ])
    expect(
      currentStep(start({ facts: [...ALL_BEFORE("contact"), PHONE, EMAIL] }))
        ?.id
    ).toBe("assistant")
  })

  it("asks the business name after what it does, when sign-up gave none, filled in from the org", () => {
    expect(currentStep(start({ facts: [] }))?.id).toBe("business.offerings")
    expect(cardFor("business.name").input).toEqual({
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

  it("asks who the customers are once, whoever asked it", () => {
    const at = start({ facts: ALL_BEFORE("business.audience") })
    expect(currentStep(at)?.id).toBe("business.audience")
    expect(currentStep({ ...at, asked: { "business.audience": 1 } })?.id).toBe(
      "business.proof"
    )
  })

  it("asks what sets the business apart once, skippable, and never holds anything up for it", () => {
    const at = start({ facts: ALL_BEFORE("business.proof") })
    expect(currentStep(at)?.id).toBe("business.proof")
    expect(cardFor("business.proof").input).toEqual({
      key: "business.proof",
      skippable: true,
      prefill: null,
    })
    expect(
      cardAnswer(cardFor("business.proof"), { answer: "skipped" }, [])
    ).toEqual({ kind: "passed", step: "business.proof" })
    expect(
      typedAnswer(cardFor("business.proof"), "Nothing special really")
    ).toEqual({ kind: "passed", step: "business.proof" })
    expect(
      typedAnswer(cardFor("business.proof"), "Gas Safe, 20 years")
    ).toMatchObject({ facts: [{ value: { text: "Gas Safe, 20 years" } }] })
    // Asked once in words by the planner: the script moves on.
    expect(currentStep({ ...at, asked: { "business.proof": 1 } })?.id).toBe(
      "industry"
    )
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
    const facts = ALL_BEFORE("build_for_me")
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

/** Every fact the walk states, choices included, in the script's order. */
const ALL: FactValue[] = [
  { key: "business.name", value: { name: BUSINESS } },
  ...(FACTS["business.offerings"] as FactValue[]),
  ...(FACTS["service_area.text"] as FactValue[]),
  ...(FACTS["business.audience"] as FactValue[]),
  ...(FACTS["business.proof"] as FactValue[]),
  { key: "business.industry", value: { name: "x", category: null } },
  ...(FACTS.contact as FactValue[]),
  ...(FACTS.assistant as FactValue[]),
  ...(FACTS["owner.preferred_name"] as FactValue[]),
  { key: "site.build_mode", value: { mode: "assistant" } },
  { key: "site.template", value: { id: "classic" } },
  { key: "site.palette", value: { id: "ocean" } },
  { key: "site.font", value: { id: "clean_sans" } },
  { key: "site.pages", value: { ids: ["home", "quote"] } },
  QUOTE,
]

/** Each step's facts, where they are not the step's own key. */
const KEYS: Partial<Record<StepId, string[]>> = {
  industry: ["business.industry"],
  contact: ["business.phone", "business.email"],
  assistant: ["assistant.name", "assistant.pronouns", "assistant.tone"],
  build_for_me: ["site.build_mode"],
  design: ["site.direction"],
  template: ["site.template"],
  palette: ["site.palette"],
  font: ["site.font"],
  pages: ["site.pages"],
  quote_form: ["quote.form"],
}

/** Every fact of the steps before `step`, the business name always. */
function ALL_BEFORE(step: StepId): FactValue[] {
  const order = STEPS.map((s) => s.id)
  const before = new Set([
    "business.name",
    ...order.slice(0, order.indexOf(step)).flatMap((id) => KEYS[id] ?? [id]),
  ])
  return ALL.filter((f) => before.has(f.key))
}

/** The card the api makes for `step`, with every earlier step's fact held. */
function cardFor(step: StepId): ToolPart {
  const facts = ALL_BEFORE(step).filter(
    (f) => step !== "business.name" || f.key !== "business.name"
  )
  // The four cards the tray replaced are asked to an org that was on them.
  const at = start({
    facts,
    ...(["template", "palette", "font", "pages"].includes(step)
      ? { oldDesign: true }
      : {}),
  })
  const card = onboardingStep(at, counter()).find((p) =>
    p.type.startsWith("tool-")
  ) as ToolPart
  expect(stepOf(card)).toBe(step)
  return card
}

describe("an answer on a card", () => {
  it("refuses an id the card did not offer, two where one is asked, and nothing at all", () => {
    const card = cardFor("build_for_me")
    for (const output of [
      { answer: "chosen", ids: ["maybe"], other: null },
      { answer: "chosen", ids: ["yes", "skip"], other: null },
      { answer: "chosen", ids: [], other: null },
      { answer: "chosen", ids: [], other: "only the homepage" },
      { answer: "skipped" },
    ]) {
      expect(cardAnswer(card, output, [])).toBeNull()
    }
    expect(
      cardAnswer(card, { answer: "chosen", ids: ["yes"], other: null }, [])
    ).toEqual({
      kind: "facts",
      facts: [{ key: "site.build_mode", value: { mode: "assistant" } }],
    })
  })

  it("states a details card's facts, only the step's own keys, each once, and never a skip", () => {
    const card = cardFor("assistant")
    const facts = FACTS.assistant as FactValue[]
    expect(cardAnswer(card, { answer: "stated", facts }, [])).toEqual({
      kind: "facts",
      facts,
    })
    // Part of the card is an answer too; the step asks again for the rest.
    expect(
      cardAnswer(card, { answer: "stated", facts: facts.slice(0, 1) }, [])
    ).toEqual({ kind: "facts", facts: facts.slice(0, 1) })
    for (const output of [
      { answer: "stated", facts: [PHONE] },
      { answer: "stated", facts: [facts[0], facts[0]] },
      { answer: "stated", facts: [] },
      { answer: "skipped" },
    ]) {
      expect(cardAnswer(card, output, [])).toBeNull()
    }
    expect(
      cardAnswer(
        cardFor("contact"),
        { answer: "stated", facts: [PHONE, EMAIL] },
        []
      )
    ).toEqual({ kind: "facts", facts: [PHONE, EMAIL] })
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

  it("offers the whole pool, four first, from four families, the same four on every call", () => {
    const card = cardFor("palette")
    const input = AskChoiceInput.parse(card.input)
    expect(input.options.map((o) => o.id)).toEqual(PaletteId.options)
    expect(input.color).toBe(true)
    expect(input.initial).toHaveLength(4)
    expect(input.initial).toEqual(firstPalettes(ORG))
    expect(AskChoiceInput.parse(cardFor("palette").input).initial).toEqual(
      input.initial
    )
    const firsts = new Set(ORGS.map((org) => firstPalettes(org).join()))
    expect(firsts.size).toBeGreaterThan(10)
    // One per family: never two of the three blues together.
    const blues = ["ocean", "classic_blue", "harbour"]
    for (const org of ORGS) {
      const shown = firstPalettes(org)
      expect(new Set(shown).size).toBe(4)
      expect(shown.filter((id) => blues.includes(id)).length).toBeLessThan(2)
    }
    // Every other choice card shows all its options.
    expect(AskChoiceInput.parse(cardFor("font").input).initial).toBeUndefined()
  })

  it("takes a picked colour as the brand, words as guidance, and refuses a bad code", () => {
    const card = cardFor("palette")
    const own = (other: string) =>
      cardAnswer(card, { answer: "chosen", ids: [], other }, [])
    const brand = PALETTES[3]?.brand ?? ""
    expect(own(brand.toUpperCase())).toEqual({
      kind: "facts",
      facts: [{ key: "site.palette", value: { id: "custom", brand } }],
    })
    expect(own("Navy and gold")).toMatchObject({
      facts: [{ value: { id: "custom", custom: "Navy and gold" } }],
    })
    expect(own(brand.slice(0, 5))).toBeNull()
    expect(own(`${brand}0`)).toBeNull()
    expect(
      cardAnswer(card, { answer: "chosen", ids: ["berry"], other: null }, [])
    ).toMatchObject({ facts: [{ value: { id: "berry" } }] })
  })

  it("names the chosen colours before the lettering question", () => {
    const brand = PALETTES[0]?.brand ?? ""
    expect(question("font", voice())).toMatch(/^Ocean it is\. /)
    expect(
      question("font", voice({ palette: null, ownColour: brand }))
    ).toContain(`around ${brand}.`)
    expect(
      question("font", voice({ palette: null, ownColour: "Navy and gold" }))
    ).toContain('match "Navy and gold".')
    expect(question("font", voice({ palette: null, ownColour: null }))).toMatch(
      /^(And|Now)/
    )
  })

  it("words the quote-form step from what the owner picked, never from a template that is not there", () => {
    const none = { template: null, palette: null }
    const said = (over: Partial<Voice>) =>
      question("quote_form", voice({ ...none, ...over }))
    expect(said({ direction: "Counsel", palette: "Ocean" })).toContain(
      "the Counsel look in Ocean"
    )
    expect(said({ direction: "Counsel" })).toContain("the Counsel look")
    expect(said({ palette: "Ocean" })).toContain("the Ocean colours")
    expect(said({ ownLook: "airy and plain" })).toContain(
      "the look you described"
    )
    expect(said({ ownColour: "Navy and gold" })).toContain(
      "the look you described"
    )
    expect(said({})).toContain(`the look I'll choose for ${BUSINESS}`)
    for (const over of [{}, { direction: "Counsel" }, { ownLook: "airy" }])
      expect(said(over)).not.toContain("you've chosen")
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

  it("skips only who the customers are among the facts, and takes only photos the org holds", () => {
    expect(
      cardAnswer(cardFor("service_area.text"), { answer: "skipped" }, [])
    ).toBeNull()
    expect(
      cardAnswer(cardFor("business.audience"), { answer: "skipped" }, [])
    ).toEqual({ kind: "passed", step: "business.audience" })
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

  it("states a confirmed quote form, keeps changes as words, and refuses contact questions", () => {
    const fields = [
      {
        key: "pickup",
        label: "Pick-up address",
        type: "text",
        required: true,
        hint: null,
        options: null,
      },
      {
        key: "passengers",
        label: "Passengers",
        type: "number",
        required: true,
        hint: null,
        options: null,
      },
    ]
    const review = {
      type: "tool-review_quote_form",
      toolCallId: "c1",
      state: "input-available",
      input: { fields, note: null },
    } as ToolPart
    expect(cardAnswer(review, { answer: "confirmed", fields }, [])).toEqual({
      kind: "facts",
      facts: [{ key: "quote.form", value: { fields } }],
    })
    expect(
      cardAnswer(review, { answer: "changes", text: "Add the date" }, [])
    ).toEqual({ kind: "facts", facts: [] })
    for (const contact of [
      { key: "email", type: "text", label: "Where to reply" },
      { key: "details", type: "tel", label: "Best number" },
      { key: "who", type: "text", label: "Your name" },
    ]) {
      expect(
        cardAnswer(
          review,
          {
            answer: "confirmed",
            fields: [...fields, { ...fields[0], ...contact }],
          },
          []
        )
      ).toBeNull()
    }
    // A pet's name is not the customer's.
    expect(
      cardAnswer(
        review,
        {
          answer: "confirmed",
          fields: [
            ...fields,
            { ...fields[0], key: "pet_name", label: "Your dog's name" },
          ],
        },
        []
      )?.kind
    ).toBe("facts")
  })

  it("refuses a fact for another key than the card's", () => {
    expect(
      cardAnswer(
        cardFor("service_area.text"),
        { answer: "stated", fact: EMAIL },
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
  const form = (key: Parameters<typeof factCard>[1], words: string) =>
    typedAnswer(factCard(start(), key, counter()), words)
  const choice = (step: Parameters<typeof choiceCard>[0], words: string) =>
    typedAnswer(choiceCard(step, start(), counter()), words)

  it("takes the words as a text ask's value, a phone number as E.164", () => {
    expect(form("business.phone", "+44 (1632) 960-001")).toEqual({
      kind: "facts",
      facts: [{ key: "business.phone", value: { e164: "+441632960001" } }],
    })
    expect(form("business.phone", "0044 1632 960001")).toMatchObject({
      facts: [{ value: { e164: "+441632960001" } }],
    })
    expect(
      facts("business.offerings", "Regular cleaning, deep cleans and ovens")
    ).toMatchObject({
      facts: [
        { value: { items: ["Regular cleaning", "deep cleans and ovens"] } },
      ],
    })
    expect(form("assistant.name", "  Maya ")).toMatchObject({
      facts: [{ value: { name: "Maya" } }],
    })
  })

  it("asks again with a specific line when the words do not fit", () => {
    expect(form("business.phone", "01632 960001")).toEqual({
      kind: "retry",
      reason: "phone",
    })
    expect(form("business.email", "hello at brightclean")).toEqual({
      kind: "retry",
      reason: "email",
    })
    expect(form("assistant.name", "x".repeat(100))).toEqual({
      kind: "retry",
      reason: "long",
    })
  })

  it("finds an email and a full number typed over the contact card, and asks again for the rest", () => {
    expect(
      facts("contact", "It's +44 1632 960001, and hello@brightclean.invalid")
    ).toEqual({ kind: "facts", facts: [EMAIL, PHONE] })
    expect(facts("contact", "hello@brightclean.invalid")).toEqual({
      kind: "facts",
      facts: [EMAIL],
    })
    expect(facts("contact", "ring me")).toEqual({
      kind: "retry",
      reason: "details",
    })
    expect(facts("assistant", "Call yourself Maya")).toEqual({
      kind: "retry",
      reason: "details",
    })
  })

  it("matches a choice by label or id, and takes the owner's words where the card has an Other", () => {
    expect(choice("pronouns", "She/Her.")).toMatchObject({
      facts: [{ value: { id: "she_her" } }],
    })
    expect(choice("pronouns", "they")).toMatchObject({
      facts: [{ value: { id: "they_them" } }],
    })
    expect(choice("tone", "PROFESSIONAL")).toMatchObject({
      facts: [{ value: { id: "professional" } }],
    })
    expect(choice("pronouns", "whatever")).toEqual({
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

  it("skips the photos and who the customers are, and asks again for anything else on the photo card", () => {
    expect(facts("upload", "I don't have any")).toEqual({
      kind: "passed",
      step: "upload",
    })
    expect(facts("upload", "here you go")).toEqual({
      kind: "retry",
      reason: "upload",
    })
    expect(facts("business.audience", "skip")).toEqual({
      kind: "passed",
      step: "business.audience",
    })
    expect(facts("business.audience", "Busy families")).toMatchObject({
      facts: [{ value: { text: "Busy families" } }],
    })
  })

  it("reads a reply to a question asked in words as the step the script is on", () => {
    const open = openCard(start(), () => "open")
    expect(open).toMatchObject({
      type: "tool-ask_fact",
      toolCallId: "open",
      input: { key: "business.offerings" },
    })
    expect(typedAnswer(open as ToolPart, "Weddings, proms")).toMatchObject({
      facts: [{ value: { items: ["Weddings", "proms"] } }],
    })
    // The quote question: no model to read it, so the script's short form.
    const quote = openCard(
      start({ facts: ALL_BEFORE("quote_form") }),
      () => "open"
    ) as ToolPart
    expect(quote).toMatchObject({
      type: "tool-review_quote_form",
      input: { fields: DEFAULT_QUOTE_FIELDS },
    })
    expect(typedAnswer(quote, "The date and the address")).toEqual({
      kind: "retry",
      reason: "quote",
    })
    // A step asked with a card has no card in words.
    expect(
      openCard(start({ facts: ALL_BEFORE("contact") }), () => "open")
    ).toBeUndefined()
  })
})

describe("a reply Jev read", () => {
  it("picks the option it named, on a choice card only", () => {
    const card = cardFor("template")
    expect(decided(card, { kind: "answer", option: "bold" }, start())).toEqual({
      kind: "facts",
      facts: [{ key: "site.template", value: { id: "bold" } }],
    })
    expect(
      decided(card, { kind: "answer", option: "neon" }, start())
    ).toBeNull()
    expect(
      decided(cardFor("contact"), { kind: "answer", option: "x" }, start())
    ).toBeNull()
  })

  it("picks for an owner who left it to the assistant, and says what it picked", () => {
    const at = start({ facts: ALL_BEFORE("palette") })
    const picked = decided(cardFor("palette"), { kind: "defer" }, at)
    expect(picked).toMatchObject({
      kind: "facts",
      facts: [{ key: "site.palette", value: { id: firstPalettes(ORG)[0] } }],
      chose: expect.stringContaining("colours"),
    })
    const parts = withChoice(picked ?? undefined, at, [
      { type: "text", text: "Next question?", state: "done" },
    ])
    expect((parts[0] as { text: string }).text).toMatch(
      /colours[\s\S]*\n\nNext question\?$/
    )
    // The assistant's details: only what the owner has not said.
    const named = start({
      facts: [
        ...ALL_BEFORE("assistant"),
        { key: "assistant.name", value: { name: "Maya" } },
      ],
    })
    expect(decided(cardFor("assistant"), { kind: "defer" }, named)).toEqual({
      kind: "facts",
      facts: [
        { key: "assistant.pronouns", value: { id: "they_them" } },
        { key: "assistant.tone", value: { id: "friendly" } },
      ],
      chose: expect.any(String),
    })
    // What the business does, its contact details and the build are the owner's.
    for (const step of ["industry", "contact", "build_for_me"] as const) {
      expect(decided(cardFor(step), { kind: "defer" }, start())).toBeNull()
    }
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
        row({ step: "business.audience", answer: "skipped" }),
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
      passed: ["business.audience", "upload"],
      closed: ["business.audience", "upload", "manual_builder"],
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

  it("closes a step by its latest card, and never a quote form sent back with changes", () => {
    const upload = { type: "tool-ask_upload" }
    const quote = { type: "tool-review_quote_form" }
    // Talked over, then asked again: still open.
    expect(
      progressOf([
        row({ ...upload, state: "output-error", reply: "soon" }),
        row({ ...upload, state: "input-available" }),
      ]).closed
    ).toEqual([])
    // Talked over and not asked again: the typed reply settled it.
    expect(
      progressOf([row({ ...upload, state: "output-error", reply: "no" })])
        .closed
    ).toEqual(["upload"])
    expect(progressOf([row({ ...quote, answer: "changes" })]).closed).toEqual(
      []
    )
    expect(
      progressOf([
        row({ ...quote, answer: "changes" }),
        row({ ...quote, answer: "confirmed" }),
      ]).closed
    ).toEqual(["quote_form"])
  })

  it("does not count a typed answer that was not a skip", () => {
    expect(
      progressOf([
        row({ type: "tool-ask_upload", state: "output-error", reply: "soon" }),
        row({ step: "service_area.text", state: "output-error", reply: "no" }),
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
  direction: null,
  ownLook: null,
  ownColour: null,
  services: null,
  photoQuestion: null,
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
  ["default_quote_form", quoteForm(v)],
  ["started", started(v, true)],
  ["manual_yes", manualEnd(v, true)],
  ["manual_no", manualEnd(v, false)],
]

/** The lines that name the business in every wording. */
const NAMED = ["opener", "industry", "assistant", "started"]

describe("the onboarding copy", () => {
  it("never uses an em dash, a price, a currency or a tier, and names the business where it should", {
    // Every line, every org, industry and tone: slow when the suite runs in parallel.
    timeout: 30_000,
  }, () => {
    // Each distinct line once: most lines repeat across orgs and industries,
    // and checking every copy timed the test out under the parallel suite.
    const seen = new Map<string, [string, string, string]>()
    for (const org of ORGS) {
      for (const industry of INDUSTRY_VOICES) {
        for (const { id: tone } of TONES) {
          for (const [name, text] of lines(voice({ org, industry, tone }))) {
            seen.set(`${tone}\u0000${name}\u0000${text}`, [tone, name, text])
          }
        }
      }
    }
    for (const [tone, name, text] of seen.values()) {
      expect(text, name).not.toMatch(/[—–]/)
      expect(text, name).not.toMatch(
        /[$£€]|\bprices?\b|\bpricing\b|\btiers?\b|\brates?\b|\bfees?\b/i
      )
      expect(text, name).not.toMatch(/\d+\s*(?:an hour|per hour|\/h)/i)
      expect(text, name).not.toMatch(/\(s?he\/|\(they\//)
      expect(text, name).not.toMatch(/\bReme\b/)
      if (NAMED.includes(name)) expect(text, name).toContain(BUSINESS)
      if (tone === "professional") expect(text, name).not.toContain("!")
    }
  })

  it("keeps one org's wording on every call, and varies it across orgs", () => {
    const once = lines(voice())
    expect(lines(voice())).toEqual(once)
    for (const name of [
      "opener",
      "assistant",
      "contact",
      "owner.preferred_name",
      "build_for_me",
      "quote_form",
      "upload",
      "started",
      "business.audience",
      "business.proof",
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

  it("asks the photo question written for the business when it is ready, and always welcomes a logo", () => {
    const fleet =
      "Do you have photos of your fleet, inside and out, or your chauffeurs in uniform?"
    for (const org of ORGS) {
      const asked = photos(voice({ org, photoQuestion: fleet }))
      expect(asked).toContain(fleet)
      expect(asked).toMatch(/\blogo\b/)
      expect(photos(voice({ org }))).toMatch(/\blogo\b/)
    }
    const prepared = voice({ services: "your wedding cars and airport runs" })
    expect(
      ORGS.map((org) => question("quote_form", { ...prepared, org })).join()
    ).toContain("your wedding cars and airport runs")
  })

  it("mentions the quote page when it turns to the website", () => {
    for (const org of ORGS) {
      expect(question("build_for_me", voice({ org }))).toContain(
        "Request a quote"
      )
      expect(question("build_for_me", voice({ org }))).toContain(
        "Would you like me to build your website for you?"
      )
    }
  })

  it("asks what a quote needs after the design, in words", () => {
    for (const org of ORGS) {
      const asked = question("quote_form", voice({ org }))
      expect(asked).toMatch(/quote/)
      expect(asked.trim()).toMatch(/\?$/)
    }
  })

  it("speaks of the draft in the first person, whatever the pronouns", () => {
    for (const org of ORGS) {
      for (const pronouns of ["he_him", "she_her", "they_them"] as const) {
        const text = question("build_for_me", voice({ org, pronouns }))
        expect(text).toContain("Would you like me to build")
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
    expect(at("casual")).toMatch(/\bWant me to build\b/)
  })

  it("opens with text only: thanks by first name, the plan, and what the business does", () => {
    const seen = new Set<string>()
    for (const org of ORGS) {
      const parts = opening(start({ orgId: org }))
      expect(parts).toHaveLength(1)
      const text = (parts[0] as { type: string; text: string }).text
      expect(parts[0]?.type).toBe("text")
      expect(text).toContain("Probe")
      expect(text).not.toContain("Probe Owner")
      expect(text).toContain(BUSINESS)
      expect(text).toMatch(/business assistant/)
      expect(text).toMatch(/quick questions/)
      expect(text).toMatch(/website/)
      expect(text.trim()).toMatch(/\?$/)
      expect(text).not.toMatch(/[—–]|\bReme\b/)
      expect(text.split("\n\n").length).toBeLessThanOrEqual(3)
      seen.add(text)
      // No name from the sign-in: no stray comma or space before it.
      const nameless = (
        opening(start({ orgId: org, ownerName: "" }))[0] as { text: string }
      ).text
      expect(nameless).not.toMatch(/ ,| {2}/)
    }
    expect(seen.size).toBeGreaterThanOrEqual(6)
  })
})

describe("the design tray", () => {
  /** What is held before the tray, with the industry's category as given. */
  const heldBefore = (category: string | null = "cleaning"): FactValue[] => [
    ...ALL_BEFORE("design").filter((f) => f.key !== "business.industry"),
    { key: "business.industry", value: { name: "x", category } as never },
  ]
  const tray = (over: Partial<Onboarding> = {}) =>
    AskDesignInput.parse(
      (
        onboardingStep(
          start({ facts: heldBefore(), ...over }),
          counter()
        )[1] as ToolPart
      ).input
    )
  const ids = (design: AskDesignInput, id: string) =>
    design.questions.find((q) => q.id === id)?.card.options.map((o) => o.id) ??
    []

  it("is one step of four questions, each with its own text, after the website question", () => {
    const input = tray()
    expect(input.questions.map((q) => q.id)).toEqual([
      "palette",
      "lettering",
      "arrangement",
      "pages",
    ])
    expect(input.questions.every((q) => q.question)).toBe(true)
    expect(input.questions.map((q) => q.visual)).toEqual([
      "palette",
      "font_pair",
      "layout",
      "text",
    ])
    expect(currentStep(start({ facts: ALL_BEFORE("design") }))?.id).toBe(
      "design"
    )
  })

  it("draws every option from directions that list the industry", () => {
    for (const category of ["cleaning", "chauffeur", "legal", "education"]) {
      const input = tray({ facts: heldBefore(category) })
      const fit = DIRECTIONS.filter((d) =>
        (d.industries as readonly string[]).includes(category)
      )
      expect(ids(input, "arrangement").length).toBeGreaterThanOrEqual(2)
      for (const id of ids(input, "arrangement")) {
        expect(fit.map((d) => d.id)).toContain(id)
      }
      for (const id of ids(input, "lettering")) {
        expect(fit.map((d) => d.fonts)).toContain(id)
      }
      for (const id of ids(input, "palette")) {
        expect(fit.flatMap((d) => d.palettes)).toContain(id)
      }
      expect(ids(input, "palette")).toHaveLength(4)
    }
  })

  it("shows layouts that differ, and the pair's faces and the layout's variants as visuals", () => {
    const input = tray()
    const layouts = input.questions[2]?.card.options.map((o) => o.visual) ?? []
    const looks = layouts.map((v) => JSON.stringify(v))
    expect(new Set(looks).size).toBe(looks.length)
    for (const o of input.questions[1]?.card.options ?? []) {
      expect(o.visual).toMatchObject({ kind: "font_pair" })
    }
    for (const o of input.questions[0]?.card.options ?? []) {
      expect(o.visual).toMatchObject({ kind: "swatches" })
    }
  })

  it("seeds by org: the same four on every call, other orgs other fours", () => {
    const first = (org: string) => ids(tray({ orgId: org }), "palette").join()
    expect(first(ORG)).toBe(first(ORG))
    expect(new Set(ORGS.map(first)).size).toBeGreaterThan(10)
  })

  it("opens ticked where the org already answered", () => {
    const [palette] = ids(tray(), "palette")
    const input = tray({
      facts: [
        ...heldBefore(),
        { key: "site.palette", value: { id: palette as never } },
      ],
    })
    expect(input.questions[0]?.card.preselected).toEqual([palette])
    expect(input.questions[1]?.card.preselected).toEqual([])
  })

  it("opens on the owner's own words where the org wrote its own", () => {
    // Pages are left unanswered: with all four held the tray is done.
    const input = tray({
      facts: [
        ...heldBefore(),
        {
          key: "site.palette",
          value: { id: "custom", custom: "warm greys and brass" },
        },
        { key: "site.font", value: { id: "custom", custom: "a quiet serif" } },
        { key: "site.direction", value: { id: "custom", custom: "airy" } },
      ],
    })
    expect(input.questions.map((q) => q.card.own)).toEqual([
      "warm greys and brass",
      "a quiet serif",
      "airy",
      undefined,
    ])
    // Pages, a card of many, opens on the usual ones.
    for (const q of input.questions.slice(0, 3))
      expect(q.card.preselected).toEqual([])
    // A hex code is held as the brand colour and comes back as the words;
    // pages' own words ride beside the ids they came with.
    const code = PALETTES[0]?.brand as string
    const rest = tray({
      facts: [
        ...heldBefore(),
        { key: "site.palette", value: { id: "custom", brand: code } },
        { key: "site.pages", value: { ids: ["home"], custom: "home, fees" } },
      ],
    })
    expect(rest.questions.map((q) => q.card.own)).toEqual([
      code,
      undefined,
      undefined,
      "home, fees",
    ])
  })

  const card = () =>
    onboardingStep(start({ facts: heldBefore() }), counter())[1] as ToolPart
  const input = () => AskDesignInput.parse(card().input)
  const pick = (answers: Record<string, unknown>, skip_all = false) =>
    cardAnswer(card(), { answers, skip_all }, [], [])

  it("states each answer as a fact as given, and leaves the tray open until it is finished", () => {
    const [palette] = ids(input(), "palette")
    const partial = pick({ palette: { choice: palette } })
    expect(partial).toEqual({
      kind: "design",
      facts: [{ key: "site.palette", value: { id: palette } }],
      settled: false,
    })
    const all = pick({
      palette: { choice: palette },
      lettering: { choice: ids(input(), "lettering")[0] },
      arrangement: { choice: ids(input(), "arrangement")[0] },
      pages: { choices: ["services", "gallery", "faq"] },
    })
    expect(all).toMatchObject({ kind: "design", settled: true })
    expect((all as { facts: FactValue[] }).facts.map((f) => f.key)).toEqual([
      "site.palette",
      "site.font",
      "site.direction",
      "site.pages",
    ])
    expect((all as { facts: FactValue[] }).facts.at(-1)?.value).toEqual({
      ids: ["home", "services", "gallery", "faq", "quote"],
    })
  })

  it("never offers two letterings with the same title font", () => {
    for (let n = 0; n < 20; n++) {
      const orgId = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
      const offered = tray({ orgId })
        .questions.find((q) => q.id === "lettering")
        ?.card.options.map((o) => o.id)
        .filter((id) => id !== "custom")
      const families = offered?.map(
        (id) => FONT_PAIRS.find((pair) => pair.id === id)?.display.family
      )
      expect(new Set(families).size).toBe(families?.length)
    }
  })

  it("asks for pages one tick each, the usual ones or the held ones ticked", () => {
    const pages = input().questions.find((q) => q.id === "pages")?.card
    expect(pages?.multiple).toBe(true)
    expect(pages?.options.map((o) => o.id)).toEqual([
      "services",
      "about",
      "gallery",
      "testimonials",
      "faq",
      "service_area",
      "contact",
    ])
    // Every owner gave their area by now, so its page is ticked too.
    expect(pages?.preselected).toEqual([
      "services",
      "about",
      "service_area",
      "contact",
    ])
    const held = tray({
      facts: [
        ...heldBefore(),
        { key: "site.pages", value: { ids: ["home", "gallery", "quote"] } },
      ],
    }).questions.find((q) => q.id === "pages")?.card
    expect(held?.preselected).toEqual(["gallery"])
  })

  it("ticks the areas and reviews pages when the owner already gave them", () => {
    const pages = tray({
      facts: [
        ...heldBefore().filter((f) => f.key !== "business.proof"),
        { key: "service_area.text", value: { text: "Reading and 15 miles" } },
        {
          key: "business.proof",
          value: { text: "4.9 on Google from 120 reviews." },
        },
      ],
    }).questions.find((q) => q.id === "pages")?.card
    expect(pages?.preselected).toEqual([
      "services",
      "about",
      "testimonials",
      "service_area",
      "contact",
    ])
  })

  it("reads the pages an owner names in their own words as ticked", () => {
    // The words of the 2026-10-15 run, which once kept only Home and quote.
    expect(
      pick({
        pages: {
          own: "Home, Services, About, Gallery, FAQ, Contact, Request a quote",
        },
      })
    ).toMatchObject({
      facts: [
        {
          key: "site.pages",
          value: {
            ids: [
              "home",
              "services",
              "about",
              "gallery",
              "faq",
              "contact",
              "quote",
            ],
            custom:
              "Home, Services, About, Gallery, FAQ, Contact, Request a quote",
          },
        },
      ],
    })
    expect(pagesNamed("FAQs and reviews, plus the service area")).toEqual([
      "testimonials",
      "faq",
      "service_area",
    ])
    expect(pagesNamed("a blog and a price list")).toEqual([])
  })

  it("leaves out a page the owner's words turn down", () => {
    expect(pagesNamed("Home, no gallery, FAQ")).toEqual(["home", "faq"])
    expect(pagesNamed("Services but not FAQ")).toEqual(["services"])
    expect(pagesNamed("Contact, without a gallery")).toEqual(["contact"])
    expect(pagesNamed("We don't need FAQ")).toEqual([])
    expect(pagesNamed("no need for a gallery or FAQs")).toEqual([])
    expect(pagesNamed("I don't need a gallery, but add FAQs")).toEqual(["faq"])
    expect(pagesNamed("Gallery and FAQ")).toEqual(["gallery", "faq"])
    expect(pick({ pages: { own: "About us, no gallery" } })).toMatchObject({
      facts: [
        {
          key: "site.pages",
          value: {
            ids: ["home", "about", "quote"],
            custom: "About us, no gallery",
          },
        },
      ],
    })
  })

  it("keeps the owner's own words, a colour code as the brand colour", () => {
    const brand = PALETTES[3]?.brand ?? ""
    expect(pick({ palette: { own: brand.toUpperCase() } })).toMatchObject({
      facts: [{ key: "site.palette", value: { id: "custom", brand } }],
    })
    expect(
      pick({
        palette: { own: "Navy and gold" },
        lettering: { own: "Like a newspaper" },
        arrangement: { own: "A long single page" },
        pages: { own: "A blog too" },
      })
    ).toMatchObject({
      settled: true,
      facts: [
        {
          key: "site.palette",
          value: { id: "custom", custom: "Navy and gold" },
        },
        {
          key: "site.font",
          value: { id: "custom", custom: "Like a newspaper" },
        },
        {
          key: "site.direction",
          value: { id: "custom", custom: "A long single page" },
        },
        {
          key: "site.pages",
          value: { ids: ["home", "quote"], custom: "A blog too" },
        },
      ],
    })
    expect(pick({ palette: { own: "#12" } })).toBeNull()
  })

  it("refuses an answer its question did not offer", () => {
    expect(pick({ palette: { choice: "not_a_palette" } })).toBeNull()
    expect(
      pick({ lettering: { choice: ids(input(), "palette")[0] } })
    ).toBeNull()
    expect(pick({ colours: { choice: "ocean" } })).toBeNull()
    // One pick on a card of many, many on a card of one, a page set from a
    // tray before pages were ticked one by one.
    expect(pick({ pages: { choice: "gallery" } })).toBeNull()
    expect(pick({ palette: { choices: ids(input(), "palette") } })).toBeNull()
    expect(pick({ pages: { choices: ["gallery", "blog"] } })).toBeNull()
    expect(pick({ pages: { choices: ["home"] } })).toBeNull()
    expect(cardAnswer(card(), { answers: {}, skip_all: "yes" }, [])).toBeNull()
  })

  it("stores nothing on Skip all but that the look is the builder's, unless a layout is held", () => {
    expect(pick({}, true)).toEqual({
      kind: "design",
      facts: [{ key: "site.direction", value: { id: "builder" } }],
      settled: true,
    })
    expect(
      designAnswer(input(), { answers: {}, skip_all: true }, [
        { key: "site.direction", value: { id: "calm_daylight" } },
      ])
    ).toEqual({ kind: "design", facts: [], settled: true })
    const answered = pick(
      { palette: { skipped: true }, lettering: { skipped: true } },
      true
    )
    expect((answered as { facts: FactValue[] }).facts).toHaveLength(1)
  })

  it("is done once finished, or once every answer is held, and is not asked of an org on the old cards", () => {
    const at = start({ facts: ALL_BEFORE("design") })
    expect(designDone(at)).toBe(false)
    const finished = applied(at, pick({}, true) as never)
    expect(designDone(finished)).toBe(true)
    expect(currentStep(finished)?.id).toBe("quote_form")
    // Four held answers with the tray never closed: still done.
    const held = start({
      facts: [
        ...ALL_BEFORE("design"),
        { key: "site.palette", value: { id: "ocean" } },
        { key: "site.font", value: { id: "sora_manrope" } },
        { key: "site.direction", value: { id: "fresh_modern" } },
        { key: "site.pages", value: { ids: ["home", "quote"] } },
      ],
    })
    expect(designDone(held)).toBe(true)
    // Mid-way through the old cards on deploy day: they finish.
    expect(
      currentStep(start({ facts: ALL_BEFORE("design"), oldDesign: true }))?.id
    ).toBe("template")
    expect(
      currentStep(
        start({
          facts: [
            ...ALL_BEFORE("design"),
            { key: "site.template", value: { id: "classic" } },
          ],
        })
      )?.id
    ).toBe("palette")
  })

  it("reads a conversation that asked one of the old cards as one that finishes on them", () => {
    const row = (type: string, state: string, step: string | null = null) => ({
      type,
      state,
      step,
      answer: null,
      choice: null,
      reply: null,
    })
    expect(
      progressOf([row("tool-ask_choice", "output-available", "template")])
        .oldDesign
    ).toBe(true)
    expect(
      progressOf([row("tool-ask_design", "input-available")])
    ).toMatchObject({ closed: [] })
    expect(
      progressOf([row("tool-ask_design", "output-available")])
    ).toMatchObject({ closed: ["design"] })
    expect(
      progressOf([row("tool-ask_choice", "output-available", "industry")])
        .oldDesign
    ).toBeUndefined()
  })
})
