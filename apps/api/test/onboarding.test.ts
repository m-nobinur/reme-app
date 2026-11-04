import {
  AskChoiceInput,
  AskDesignInput,
  AskDetailsInput,
  BuildQuestions,
  CALM_PALETTES,
  type FactValue,
  FONT_PAIRS,
  INDUSTRIES,
  NAME_IDEAS,
  PALETTES,
  PaletteId,
  RECAP_REPLY,
  SKIP_REPLY,
  TONES,
} from "@workspace/contracts"
import DIRECTIONS from "@workspace/starter-site/directions.json"
import { describe, expect, it } from "vitest"
import type { ToolPart } from "../src/chat.ts"
import { tableStart } from "../src/design-start.ts"
import {
  addressOffer,
  again,
  applied,
  built,
  call,
  cardAnswer,
  choiceCard,
  chosen,
  currentStep,
  DEFAULT_QUOTE_FIELDS,
  decided,
  designAnswer,
  designDone,
  detailsCard,
  ended,
  factCard,
  factValue,
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
  trayOption,
  typedAnswer,
  voiceOf,
  withChoice,
} from "../src/onboarding.ts"
import {
  back,
  chose,
  firstName,
  manualEnd,
  opener,
  question,
  quoteForm,
  quoteUnchanged,
  recap,
  retry,
  say,
  started,
  type Voice,
} from "../src/onboarding-copy.ts"
import { voiceProblems } from "../src/voice.ts"

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
  "business.prices": [
    { key: "business.prices", value: { text: "Regular clean from 60." } },
  ],
  "business.enquiries": [
    { key: "business.enquiries", value: { text: "Calls and texts." } },
  ],
  contact: [PHONE, EMAIL],
  assistant: [
    { key: "assistant.name", value: { name: "Maya" } },
    { key: "assistant.pronouns", value: { id: "she_her" } },
    { key: "assistant.avatar", value: { id: "she_1" } },
    { key: "assistant.tone", value: { id: "friendly" } },
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
    if (currentStep(at)?.id === "quote_form") {
      asked.push("quote_form")
      at = applied(at, { kind: "facts", facts: [QUOTE] })
      continue
    }
    // The recap is answered in words: its confirm pill sends RECAP_REPLY.
    if (card && stepOf(card) === "recap") {
      asked.push("recap")
      at = applied(at, typedAnswer(card, RECAP_REPLY))
      continue
    }
    if (!card) return { asked, at, step }
    const id = card.type === "tool-request_change" ? "build" : stepOf(card)
    asked.push(id as StepId)
    if (id === "build") return { asked, at, step }
    // The logo page keeps the logo before the tray's answer names it.
    const answer = cardAnswer(card, answers(card), [], [...at.facts, UPLOADS])
    if (!answer) throw new Error(`refused ${id}`)
    at = applied(at, answer)
  }
  throw new Error("the script did not end")
}

/** The logo the logo page kept, as `media.uploads` holds it. */
const LOGO = {
  id: "0d9e0f10-2131-4a2b-9c3d-4e5f60718293",
  name: "logo.png",
  content_type: "image/png",
  bytes: 4821,
  use: "logo",
} as const
const UPLOADS = { key: "media.uploads", value: { items: [LOGO] } }

/** A photo card from a conversation before the photos joined the tray: it still reads. */
const OLD_UPLOAD: ToolPart = {
  type: "tool-ask_upload",
  toolCallId: "old_upload",
  state: "input-available",
  input: {
    accept: ["image/jpeg", "image/png", "image/webp"],
    max_files: 12,
    max_bytes: 10_000_000,
    skippable: true,
  },
}

const everyCard = (card: ToolPart): unknown => {
  const step = stepOf(card) as StepId
  if (card.type === "tool-ask_design") {
    const { questions } = AskDesignInput.parse(card.input)
    return {
      answers: Object.fromEntries(
        questions.map((q) => {
          const first = q.card.options[0]?.id
          return [
            q.id,
            q.visual === "logo"
              ? { logo: LOGO }
              : q.visual === "photos"
                ? { photos: [], create: true }
                : q.card.multiple
                  ? { choices: [first] }
                  : { choice: first },
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
      "quote_form",
      "contact",
      "recap",
      "assistant",
      "build_for_me",
      "design",
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
          expect.objectContaining({
            type: "tool-ask_open",
            input: { about: "quote.form" },
          }),
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

  it("never starts a build before the quote form is confirmed or declined, then the design", () => {
    const { asked, at } = walk(start(), everyCard)
    expect(asked.indexOf("quote_form")).toBeLessThan(asked.indexOf("design"))
    expect(asked.slice(-2)).toEqual(["design", "build"])
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
      prefill: [],
      skippable: false,
      sign_in_email: "probe@brightclean.invalid",
    })
    const half = start({ facts: [...ALL_BEFORE("contact"), PHONE] })
    expect(currentStep(half)?.id).toBe("contact")
    expect(
      AskDetailsInput.parse(
        (onboardingStep(half, counter())[1] as ToolPart).input
      )
    ).toMatchObject({
      prefill: [PHONE],
      sign_in_email: "probe@brightclean.invalid",
    })
    expect(
      currentStep(start({ facts: [...ALL_BEFORE("contact"), PHONE, EMAIL] }))
        ?.id
    ).toBe("recap")
  })

  it("reads the business back from its facts before the assistant's setup, and moves on once the owner confirms", () => {
    const facts = [
      ...ALL_BEFORE("contact").filter(
        (f) =>
          ![
            "business.offerings",
            "business.audience",
            "service_area.text",
          ].includes(f.key)
      ),
      {
        key: "business.offerings",
        value: {
          items: ["End of tenancy cleans", "Oven cleaning", "MOT tests"],
        },
      },
      { key: "business.audience", value: { text: "Mostly families." } },
      {
        key: "service_area.text",
        value: {
          text: "We cover Bristol and Bath, and we'll go to Wells for our regulars.",
        },
      },
      {
        key: "business.disclaimer",
        value: { text: "No offices or commercial sites." },
      },
      PHONE,
      EMAIL,
    ]
    const [said, card, ...rest] = onboardingStep(start({ facts }), counter())
    expect(rest).toEqual([])
    const questions = factValue(facts, "quote.form")?.fields.length
    expect((said as { text: string }).text).toBe(
      `Here's what I have for ${BUSINESS}:\n\n- **Services:** end of tenancy cleans, oven cleaning and MOT tests\n- **Not taken on:** offices or commercial sites\n- **Area:** Bristol and Bath, and you'll go to Wells for your regulars\n- **Customers:** mostly families\n- **Quote form:** ${questions} questions\n- **Contact:** 01632 960001, hello@brightclean.invalid\n\nHave I got that right?`
    )
    expect(card).toMatchObject({
      type: "tool-ask_open",
      input: { about: "recap" },
    })
    // A fact not held has no row.
    const plain = onboardingStep(
      start({
        facts: facts.filter((f) => f.key !== "business.audience"),
        asked: { "business.audience": 1 },
      }),
      counter()
    )
    expect((plain[0] as { text: string }).text).not.toContain("Customers")
    // A yes settles it; without a model a correction cannot be read.
    const asked = card as ToolPart
    for (const words of [RECAP_REPLY, "Yes, all correct"]) {
      expect(typedAnswer(asked, words)).toEqual({
        kind: "passed",
        step: "recap",
      })
    }
    expect(typedAnswer(asked, "Yes, that's right")).toMatchObject({
      kind: "passed",
    })
    expect(typedAnswer(asked, "Change the area to Bath only")).toEqual({
      kind: "retry",
      reason: "unclear",
    })
    // Typed over, it closes; shown again, it opens.
    const over = {
      type: "tool-ask_open",
      step: "recap",
      answer: null,
      choice: null,
    }
    expect(
      progressOf([{ ...over, state: "output-error", reply: RECAP_REPLY }])
        .closed
    ).toEqual(["recap"])
    expect(
      progressOf([
        { ...over, state: "output-error", reply: "Hm, what?" },
        { ...over, state: "input-available", reply: null },
      ]).closed
    ).toEqual([])
    const confirmed = start({ facts, closed: ["recap"] })
    const [lead, persona] = onboardingStep(confirmed, counter())
    expect(persona).toMatchObject({ input: { step: "assistant" } })
    expect((lead as { text: string }).text).not.toMatch(/\?/)
  })

  it("asks the business name after what it does, when sign-up gave none, filled in from the org", () => {
    expect(currentStep(start({ facts: [] }))?.id).toBe("business.offerings")
    expect(cardFor("business.name").input).toEqual({
      key: "business.name",
      skippable: false,
      prefill: { name: BUSINESS },
    })
  })

  it("calls the owner by the sign-in first name, or by the name they gave in passing", () => {
    expect(voiceOf(start()).owner).toBe("Probe")
    expect(voiceOf(start({ ownerName: "" })).owner).toBe("")
    const said = [{ key: "owner.preferred_name", value: { name: "Sam" } }]
    expect(voiceOf(start({ facts: said })).owner).toBe("Sam")
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

  it("takes the Skip branch: build mode manual, then a closing line that says connecting a site is coming", () => {
    const { asked, step } = walk(start(), (card) =>
      stepOf(card) === "build_for_me"
        ? { answer: "chosen", ids: ["skip"], other: null }
        : everyCard(card)
    )
    expect(asked.at(-1)).toBe("build_for_me")
    expect(asked).not.toContain("manual_builder")
    expect(step).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringMatching(/stay tuned/),
      }),
    ])
  })

  it("labels the build card's answers as the owner says them", () => {
    const labels = (at: Onboarding) =>
      AskChoiceInput.parse(
        (onboardingStep(at, counter())[1] as ToolPart).input
      ).options.map((o) => o.label)
    const facts = ALL_BEFORE("build_for_me")
    expect(labels(start({ facts }))).toEqual([
      "Yes, build my website",
      "No, I already have one",
    ])
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
    expect(refused).toHaveLength(3)
  })

  it("goes on to the web address offer and its card in the same reply, once the build started", () => {
    const o = start({
      facts: [
        {
          key: "business.industry",
          value: { name: "Tree surgery and garden care", category: "trades" },
        },
        {
          key: "service_area.text",
          value: { text: "Leeds and about 20 miles out" },
        },
      ],
    })
    const offer = addressOffer(o)
    expect(offer).toContain(
      "**a tree surgery and garden care business in Leeds**"
    )
    const pending: ToolPart = {
      type: "tool-request_change",
      toolCallId: "c1",
      state: "input-available",
      input: { text: ONBOARDING_GOAL },
    }
    const parts = built(
      o,
      pending,
      {
        outcome: "started",
        build: {
          assignment_id: ORG,
          kind: "site.build",
          state: "queued",
          goal: ONBOARDING_GOAL,
          revision: null,
          created_at: "2026-09-26T09:30:00.000Z",
          updated_at: "2026-09-26T09:30:00.000Z",
        },
      },
      undefined,
      offer
    )
    expect(parts.slice(3).map((p) => p.type)).toEqual([
      "step-start",
      "text",
      "data-build_questions",
    ])
    expect((parts[4] as { text: string }).text).toBe(offer)
    const stack = BuildQuestions.parse((parts[5] as { data: unknown }).data)
    expect(stack.kind).toBe("address")
  })

  it("leaves the address to the orchestrator when the email is on the business's own domain", () => {
    const own = start({
      facts: [
        { key: "business.email", value: { address: "sam@pruningco.co.uk" } },
      ],
    })
    const free = start({
      facts: [{ key: "business.email", value: { address: "sam@gmail.com" } }],
    })
    expect(addressOffer(own)).toBeNull()
    expect(addressOffer(free)).toContain("**a business like yours**")
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
  ...(FACTS["business.prices"] as FactValue[]),
  ...(FACTS["business.enquiries"] as FactValue[]),
  ...(FACTS.contact as FactValue[]),
  ...(FACTS.assistant as FactValue[]),
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
  assistant: [
    "assistant.name",
    "assistant.pronouns",
    "assistant.avatar",
    "assistant.tone",
  ],
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
  // The recap is confirmed in words, so it is closed rather than held.
  const at = start({
    facts,
    closed: step === "recap" ? [] : ["recap"],
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

  it("marks the persona values the owner left as the card suggested, and only those", () => {
    const card = cardFor("assistant")
    const { prefill } = AskDetailsInput.parse(card.input)
    const tone = { key: "assistant.tone", value: { id: "casual" } }
    const name = { key: "assistant.name", value: { name: "Ava" } }
    const touched = [
      name,
      ...prefill.filter((f) => f.key !== "assistant.tone"),
      tone,
    ]
    expect(
      cardAnswer(card, { answer: "stated", facts: touched }, [])
    ).toMatchObject({ suggested: ["assistant.pronouns", "assistant.avatar"] })
    // A value already held is the owner's to keep: never turned into a suggestion.
    expect(
      cardAnswer(card, { answer: "stated", facts: touched }, [], prefill)
    ).toMatchObject({ suggested: [] })
  })

  it("refuses a phone on a card that cannot be dialled, so it is never stored", () => {
    const contact = detailsCard("contact", start(), counter())
    const phone = (e164: string) => ({ key: "business.phone", value: { e164 } })
    expect(
      cardAnswer(
        contact,
        { answer: "stated", facts: [phone("+195899933")] },
        []
      )
    ).toBeNull()
    expect(
      cardAnswer(
        contact,
        { answer: "stated", facts: [phone("+447700900123")] },
        []
      )
    ).toMatchObject({ kind: "facts" })
  })

  it("states a details card's facts, only the step's own keys, each once, and never a skip", () => {
    const card = cardFor("assistant")
    const facts = FACTS.assistant as FactValue[]
    expect(cardAnswer(card, { answer: "stated", facts }, [])).toEqual({
      kind: "facts",
      facts,
      persona: "stated",
      suggested: ["assistant.pronouns", "assistant.avatar"],
    })
    expect(
      cardAnswer(card, { answer: "stated", facts, skip_all: true }, [])
    ).toMatchObject({ persona: "picked" })
    // Part of the card is an answer too; the step asks again for the rest.
    expect(
      cardAnswer(card, { answer: "stated", facts: facts.slice(0, 1) }, [])
    ).toEqual({
      kind: "facts",
      facts: facts.slice(0, 1),
      persona: "stated",
      suggested: [],
    })
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

  it("asks what a quote needs before any look is chosen, so never names one", () => {
    const none = { template: null, palette: null, direction: null }
    for (const org of ORGS) {
      expect(question("quote_form", voice({ ...none, org }))).not.toMatch(
        /\blook\b|\bcolours?\b|\blayout\b/i
      )
    }
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
    const upload = OLD_UPLOAD
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
    // Changes keep the form as the owner left it on the card.
    expect(
      cardAnswer(review, { answer: "changes", text: "Add the date" }, [])
    ).toEqual({ kind: "facts", facts: [], changing: fields })
    const optional = fields.map((f) => ({ ...f, required: false }))
    expect(
      cardAnswer(
        review,
        { answer: "changes", text: "Split the rooms", fields: optional },
        []
      )
    ).toMatchObject({ changing: optional })
    // With no model to redraft it, the script shows the form again rather
    // than moving on (observed 2026-10-25 on a reopened, confirmed form).
    const held = start({ facts: ALL_BEFORE("contact") })
    const changed = cardAnswer(
      review,
      { answer: "changes", text: "seperate number of rooms" },
      []
    )
    if (!changed) throw new Error("refused")
    expect(onboardingStep(applied(held, changed), counter())).toMatchObject([
      { type: "text", text: quoteUnchanged(voiceOf(held)) },
      { type: "tool-review_quote_form", input: { fields, note: null } },
    ])
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

  it("reads an open question's words as its fact, and the quote question as the short list", () => {
    const open = (about: string) =>
      call("tool-ask_open", { about }, counter()) as ToolPart
    // "All" over who the customers are, as an owner typed it: a fact, not
    // "I didn't quite catch that".
    expect(typedAnswer(open("business.audience"), "All")).toEqual({
      kind: "facts",
      facts: [{ key: "business.audience", value: { text: "All" } }],
    })
    expect(typedAnswer(open("business.proof"), "skip")).toEqual({
      kind: "passed",
      step: "business.proof",
    })
    const quote = open("quote.form")
    expect(typedAnswer(quote, "The address")).toEqual({
      kind: "retry",
      reason: "quote",
    })
    expect(
      again(quote, "quote", start(), counter()).map((p) => p.type)
    ).toEqual(["text", "tool-review_quote_form"])
  })

  it("takes the words as a text ask's value, a phone number as E.164", () => {
    expect(form("business.phone", "+44 (1632) 960-001")).toEqual({
      kind: "facts",
      facts: [{ key: "business.phone", value: { e164: "+441632960001" } }],
    })
    expect(form("business.phone", "0044 1632 960001")).toMatchObject({
      facts: [{ value: { e164: "+441632960001" } }],
    })
    // The trunk 0 drops after +44.
    expect(form("business.phone", "01632 960001")).toMatchObject({
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
    // 00 is the international prefix: +1 and too few digits to dial.
    expect(form("business.phone", "00195 899933")).toEqual({
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
    expect(typedAnswer(OLD_UPLOAD, "I don't have any")).toEqual({
      kind: "passed",
      step: "upload",
    })
    expect(typedAnswer(OLD_UPLOAD, "here you go")).toEqual({
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
    // The assistant's details answer as Pick for me does: the owner's own kept, the rest as the card opens.
    const maya: FactValue = { key: "assistant.name", value: { name: "Maya" } }
    for (const held of [[], [maya]]) {
      const now = start({ facts: [...ALL_BEFORE("assistant"), ...held] })
      const card = detailsCard("assistant", now, counter())
      const input = AskDetailsInput.parse(card.input)
      const name: FactValue[] = held.length
        ? []
        : [{ key: "assistant.name", value: { name: input.ideas?.[0] ?? "" } }]
      const button = cardAnswer(
        card,
        {
          answer: "stated",
          facts: [...input.prefill, ...name],
          skip_all: true,
        },
        [],
        now.facts
      )
      // Everything Pick for me sent is the assistant's, but a name the owner gave stays theirs.
      expect(button).toMatchObject({
        persona: "picked",
        suggested: [
          "assistant.pronouns",
          "assistant.avatar",
          "assistant.tone",
          ...(held.length ? [] : ["assistant.name"]),
        ],
      })
      expect(decided(card, { kind: "defer" }, now)).toEqual(button)
    }
    // What the business does, its contact details and the build are the owner's.
    for (const step of ["industry", "contact", "build_for_me"] as const) {
      expect(decided(cardFor(step), { kind: "defer" }, start())).toBeNull()
    }
  })

  it("leads the next question with a short line after a skip, and nothing after a confirmed recap", () => {
    const next = [
      { type: "text" as const, text: "Next question?", state: "done" as const },
    ]
    const lines = new Set<string>()
    for (const orgId of ORGS) {
      const parts = withChoice(
        { kind: "passed", step: "business.proof" },
        start({ orgId }),
        next
      )
      const said = (parts[0] as { text: string }).text
      expect(said).toMatch(
        /^(Leaving that one\.|We can come back to that\.)\n\nNext question\?$/
      )
      lines.add(said)
    }
    expect(lines.size).toBe(2)
    expect(
      withChoice({ kind: "passed", step: "recap" }, start(), next)
    ).toEqual(next)
  })
})

describe("Pick for me, answered by the script", () => {
  const PERSONA = {
    type: "data-persona",
    data: {
      name: "Maya",
      pronouns: "she_her",
      avatar: "she_1",
      tone: "friendly",
    },
  }
  const facts = FACTS.assistant as FactValue[]
  const persona = (output: object, orgId = ORG) => {
    const at = start({ orgId, facts: ALL_BEFORE("assistant") })
    const meant = cardAnswer(cardFor("assistant"), output, []) ?? undefined
    const next = applied(at, meant as NonNullable<typeof meant>)
    const step = onboardingStep(next, counter())
    return { step, parts: withChoice(meant, next, step) }
  }
  // Enough orgs to meet every wording of each line.
  const ORGS = Array.from({ length: 12 }, (_, i) => `${ORG.slice(0, -2)}${i}0`)

  it("introduces the assistant, then its persona, then the next question with no thanks", () => {
    const leads = new Set<string>()
    for (const orgId of ORGS) {
      const { step, parts } = persona(
        { answer: "stated", facts, skip_all: true },
        orgId
      )
      // The line, the persona, then the next question: no "Maya it is!" or "Thanks, Probe."
      const [said, card, lead, ...rest] = parts
      const line = (said as { text: string }).text
      const next = (lead as { text: string }).text
      expect(line).toMatch(/Maya, she\/her, with a friendly manner/)
      expect(card).toEqual(PERSONA)
      expect(next).not.toMatch(/Maya|Thanks/)
      expect(next).toMatch(/website/)
      expect(rest).toEqual(step.slice(1))
      leads.add(next)
    }
    expect(leads.size).toBe(2)
    // The owner's own answer: Maya introduces herself, the persona, then the question with no thanks.
    const intros = new Set<string>()
    for (const orgId of ORGS) {
      const own = persona({ answer: "stated", facts }, orgId)
      const [said, card, lead, ...rest] = own.parts
      const intro = (said as { text: string }).text
      expect(intro).toMatch(/Maya/)
      expect(intro).not.toMatch(/chose|choose|gone with|Leave it/)
      expect(intro).toMatch(/come across|introduce myself|preview/)
      expect(card).toEqual(PERSONA)
      expect((lead as { text: string }).text).not.toMatch(/Maya|Thanks/)
      expect(rest).toEqual(own.step.slice(1))
      intros.add(intro)
    }
    expect(intros.size).toBe(3)
  })

  it("says it chose everything only when nothing was set, and keeps the owner's own picks", () => {
    const asCome: FactValue[] = [
      { key: "assistant.name", value: { name: "Reme" } },
      { key: "assistant.pronouns", value: { id: "she_her" } },
      { key: "assistant.avatar", value: { id: "she_1" } },
      { key: "assistant.tone", value: { id: "professional" } },
    ]
    for (const orgId of ORGS) {
      const picked = persona(
        { answer: "stated", facts: asCome, skip_all: true },
        orgId
      )
      const line = (picked.parts[0] as { text: string }).text
      expect(line).toMatch(/gone with|Leave it with me|Happy to choose/)
      // The professional tone keeps contractions and ends no sentence on an exclamation mark.
      expect(line).not.toContain("!")
      // Maya, set by the owner before Pick for me, stays and is not claimed.
      const kept = persona({ answer: "stated", facts, skip_all: true }, orgId)
      const said = (kept.parts[0] as { text: string }).text
      expect(said).toMatch(/kept|stay as they are|picked the rest/)
      expect(said).toMatch(/Maya/)
    }
  })

  it("says the design tray left to it is chosen as it builds, then the build's news with no summary", () => {
    const pending: ToolPart = {
      type: "tool-request_change",
      toolCallId: "c1",
      state: "input-available",
      input: { text: ONBOARDING_GOAL },
    }
    const output = {
      outcome: "started" as const,
      build: {
        assignment_id: ORG,
        kind: "site.build" as const,
        state: "queued" as const,
        goal: ONBOARDING_GOAL,
        revision: null,
        created_at: "2026-09-26T09:30:00.000Z",
        updated_at: "2026-09-26T09:30:00.000Z",
      },
    }
    const tray = { kind: "design" as const, facts: [], settled: true }
    for (const orgId of ORGS) {
      const o = start({ orgId, facts: ALL_BEFORE("design") })
      const answer = { ...tray, picked: true as const }
      const next = applied(o, answer)
      const step = built(next, pending, output)
      const parts = withChoice(answer, next, step)
      expect(parts.slice(0, 2)).toEqual(step.slice(0, 2))
      const [line, news] = (parts[2] as { text: string }).text.split("\n\n")
      expect(line).toMatch(/as I build/)
      expect(news).not.toMatch(/everything/)
      expect(news).toMatch(/website|build/)
    }
    // Answered by the owner: no line, and the summary stays.
    const o = start({ facts: ALL_BEFORE("design") })
    const own = built(applied(o, tray), pending, output)
    expect(withChoice(tray, applied(o, tray), own)).toEqual(own)
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
      earlier: ["business.audience", "upload"],
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

  it("counts a skipped question in words, clicked or typed, and nothing else of it", () => {
    const open = (over: Record<string, unknown>) =>
      row({ type: "tool-ask_open", ...over })
    expect(
      progressOf([
        open({ step: "business.audience", answer: "skipped" }),
        open({
          step: "business.proof",
          state: "output-error",
          reply: SKIP_REPLY,
        }),
        open({ step: "service_area.text", answer: "skipped" }),
        open({ step: "business.audience", state: "input-available" }),
      ])
    ).toEqual({
      passed: ["business.audience", "business.proof"],
      closed: [],
      offered: false,
      builder: null,
    })
  })

  it("ends the script on a skipped website, clicked or typed", () => {
    const skipped = (over: Record<string, unknown>) =>
      progressOf([
        row({ type: "tool-ask_choice", step: "build_for_me", ...over }),
      ])
    const clicked = skipped({ answer: "chosen", choice: "skip" })
    expect(clicked.siteSkipped).toBe(true)
    expect(ended(clicked)).toBe(true)
    expect(ended(skipped({ state: "output-error", reply: "No thanks" }))).toBe(
      true
    )
    expect(ended(skipped({ answer: "chosen", choice: "yes" }))).toBe(false)
  })

  it("does not read a typed no as a skip once another card followed it", () => {
    const went = progressOf([
      row({
        type: "tool-ask_choice",
        step: "build_for_me",
        state: "output-error",
        reply: "No, let me change my assistant first",
      }),
      row({
        type: "tool-ask_details",
        step: "assistant",
        state: "input-available",
      }),
    ])
    expect(ended(went)).toBe(false)
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

  it("passes an optional question on the Skip this one message, typed or talked over", () => {
    for (const key of ["business.audience", "business.proof"] as const) {
      for (const card of [
        factCard(start(), key, counter()),
        call("tool-ask_open", { about: key }, counter()),
      ]) {
        expect(typedAnswer(card, SKIP_REPLY), card.type).toEqual({
          kind: "passed",
          step: key,
        })
      }
      expect(
        progressOf([
          row({ step: key, state: "output-error", reply: SKIP_REPLY }),
        ]).passed
      ).toEqual([key])
    }
  })

  it("asks a step in new words when the owner comes back to it from another", () => {
    // Observed 2026-10-25: the contact card, a reopened quote form, then the
    // contact question again word for word.
    const contact = { type: "tool-ask_details", step: "contact" }
    const progress = progressOf([
      row({ ...contact, state: "output-error", reply: "Change the quote" }),
      row({ type: "tool-review_quote_form", answer: "confirmed" }),
    ])
    expect(progress.earlier).toEqual(["contact"])
    const o = start({ ...progress, facts: ALL_BEFORE("contact") })
    const [said, card] = onboardingStep(o, counter())
    expect(said).toMatchObject({ text: back("contact", voiceOf(o)) })
    expect((said as { text: string }).text).not.toBe(
      question("contact", voiceOf(o))
    )
    expect(card).toMatchObject({ input: { step: "contact" } })
    // The latest card's own step is no return: a part answer asks as before.
    expect(progressOf([row({ ...contact, answer: "stated" })]).earlier).toBe(
      undefined
    )
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
  area: "Leeds and about 15 miles around it",
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
      (id) =>
        id !== "upload" &&
        id !== "build" &&
        id !== "manual_builder" &&
        id !== "recap"
    ) as Exclude<StepId, "upload" | "build" | "manual_builder" | "recap">[]
  ).map((id): [string, string] => [id, question(id, v)]),
  [
    "recap",
    recap(v, {
      services: ["End of tenancy cleans", "Oven cleaning", "Regular cleans"],
      excluded: "We don't take on commercial work.",
      area: "Bristol and about 15 miles out.",
      customers: "Mostly families, plus two letting agents",
      questions: 6,
      phone: "0117 496 0321",
      email: "hello@freshstart.invalid",
    }),
  ],
  ...STEPS.flatMap(({ id }): [string, string][] => {
    const line = back(id, v)
    return line ? [[`back ${id}`, line]] : []
  }),
  ["default_quote_form", quoteForm(v)],
  ["quote_unchanged", quoteUnchanged(v)],
  ["started", started(v, true)],
  ["manual_end", manualEnd(v)],
  ["chose", chose(v, "the Ocean colours")],
  ...(
    [
      "phone",
      "email",
      "long",
      "unclear",
      "choice",
      "yes_no",
      "upload",
      "details",
    ] as const
  ).map((reason): [string, string] => [`retry ${reason}`, retry(reason, v)]),
]

/** The lines that name the business in every wording. */
const NAMED = ["opener", "industry", "assistant", "started"]

describe("the owner's first name", () => {
  it("skips leading titles, and gives no name for a title alone", () => {
    expect(firstName("Sir Don")).toBe("Don")
    expect(firstName("dr. Amara Okafor")).toBe("Amara")
    expect(firstName("Mrs Prof Jane Smith")).toBe("Jane")
    expect(firstName("  Ms. Lee ")).toBe("Lee")
    expect(firstName("Sir")).toBe("")
    expect(firstName("Lady.")).toBe("")
    expect(firstName("")).toBe("")
    // A name that only starts like a title is a name.
    expect(firstName("Missy Elliott")).toBe("Missy")
    expect(firstName("Drew Barrymore")).toBe("Drew")
  })

  it("greets with no name when the account's name is only a title", () => {
    const org = ORGS.find((o) =>
      opener(voice({ org: o, owner: "" })).startsWith("Hi, good")
    )
    expect(opener(voice({ org, owner: firstName("Sir") }))).toMatch(
      /^Hi, good to meet you\./
    )
    expect(opener(voice({ org, owner: firstName("Sir Don") }))).toMatch(
      /^Hi Don, good to meet you\./
    )
  })
})

describe("the opener", () => {
  const MANY = Array.from({ length: 400 }, (_, i) => `org-${i}`)
  /** The words a reader would notice said twice. */
  const FUNCTION = new Set(
    "a an and anything as do for i'll in is it it's me of on or that the there to what with you you'd your".split(
      " "
    )
  )
  const morning = new Date("2026-11-05T09:30:00Z")

  it("renders all 27 combinations, named and unnamed, with no word said twice, no dash and short paragraphs", () => {
    for (const owner of ["Sam", ""]) {
      const seen = new Set(
        MANY.map((org) =>
          opener(voice({ org, owner }), "Europe/London", morning)
        )
      )
      expect(seen.size, owner).toBe(27)
      for (const text of seen) {
        const [first, ask, ...rest] = text.split("\n\n")
        expect(rest, text).toEqual([])
        expect(ask, text).toContain(BUSINESS)
        expect(text, text).not.toMatch(/[—–-]|website/i)
        for (const paragraph of [first, ask])
          expect(paragraph?.split(/\s+/).length, text).toBeLessThanOrEqual(52)
        const words = text
          .replace(BUSINESS, "")
          .toLowerCase()
          .match(/[a-z']+/g)
          ?.filter((w) => !FUNCTION.has(w))
        const twice = words?.filter((w, i) => words.indexOf(w) !== i)
        expect(twice, text).toEqual([])
      }
    }
  })

  it("greets by the owner's time of day, and plainly with no zone or before 5 AM", () => {
    const org = MANY.find((o) =>
      opener(voice({ org: o }), "Europe/London", morning).startsWith("Good")
    )
    const at = (zone: string | null, iso: string) =>
      opener(voice({ org }), zone, new Date(iso)).split(".")[0]
    expect(at("Europe/London", "2026-11-05T09:30:00Z")).toBe(
      "Good morning, Sam"
    )
    expect(at("Europe/London", "2026-11-05T14:00:00Z")).toBe(
      "Good afternoon, Sam"
    )
    expect(at("America/New_York", "2026-11-06T01:00:00Z")).toBe(
      "Good evening, Sam"
    )
    expect(at("Europe/London", "2026-11-05T03:00:00Z")).toBe(
      "Hi Sam, it's good to meet you"
    )
    expect(at(null, "2026-11-05T09:30:00Z")).toBe(
      "Hi Sam, it's good to meet you"
    )
    expect(opener(voice({ org, owner: "" }), "Europe/London", morning)).toMatch(
      /^Good morning\. I'm/
    )
  })
})

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
      // The prices question is the one line that asks about them.
      if (!name.endsWith("business.prices"))
        expect(text, name).not.toMatch(
          /[$£€]|\bprices?\b|\bpricing\b|\btiers?\b|\brates?\b|\bfees?\b/i
        )
      expect(text, name).not.toMatch(/\d+\s*(?:an hour|per hour|\/h)/i)
      expect(text, name).not.toMatch(/\(s?he\/|\(they\//)
      expect(text, name).not.toMatch(/\bReme\b/)
      if (NAMED.includes(name)) expect(text, name).toContain(BUSINESS)
      if (tone === "professional") expect(text, name).not.toContain("!")
      // Easy to scan: short paragraphs, bold that closes, no headings,
      // tables or emoji.
      expect(text, name).not.toMatch(/^#|^\s*\||\p{Emoji_Presentation}/mu)
      expect((text.match(/\*\*/g)?.length ?? 0) % 2, name).toBe(0)
      // Bold marks list labels only; a question stays plain.
      expect(text, name).not.toMatch(
        /\*\*[^*]*\?\s*\*\*|\*\*[^*\n]*\*\*[^.!?\n]*\?/
      )
      // The opener is the owner's approved copy, held to its own cap below.
      for (const paragraph of text.split(/\n\s*\n/))
        expect(paragraph.split(/\s+/).length, name).toBeLessThanOrEqual(
          name === "opener" ? 52 : 50
        )
      expect(voiceProblems(text, { assistantNamed: true }), name).toEqual({
        hard: [],
        soft: [],
      })
    }
  })

  it("keeps one org's wording on every call, and varies it across orgs", () => {
    const once = lines(voice())
    expect(lines(voice())).toEqual(once)
    for (const name of [
      "opener",
      "assistant",
      "contact",
      "build_for_me",
      "quote_form",
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

  it("reads the business back as labelled bullets, the owner's own asterisks kept as characters", () => {
    expect(
      recap(voice({ business: "Sparkle_Clean" }), {
        services: ["*Deep* cleans", "Ovens"],
        excluded: null,
        area: null,
        customers: "Mostly families — and two letting agents",
        questions: null,
        phone: null,
        email: "first_last@sparkle.invalid",
      })
    ).toBe(
      "Here's what I have for Sparkle\\_Clean:\n\n- **Services:** \\*Deep\\* cleans and ovens\n- **Customers:** mostly families — and two letting agents\n- **Contact:** first\\_last@sparkle.invalid\n\nHave I got that right?"
    )
  })

  it("asks the quote question with a short example answer", () => {
    for (const org of ORGS) {
      expect(question("quote_form", voice({ org }))).toMatch(
        /For instance: [^.]{10,60}\.$/
      )
    }
  })

  it("offers the website with what it does for the business, then asks", () => {
    const offers = (over: Partial<Voice>) =>
      new Set(
        ORGS.map((org) => question("build_for_me", voice({ org, ...over })))
      )
    const biopeck = {
      business: "BioPeck Clean",
      owner: "",
      industry: { name: "Cleaning company", category: null },
      area: "Leeds and 15 miles around it, we'll go as far as York",
    }
    expect([...offers(biopeck)]).toEqual(
      expect.arrayContaining([
        "Thanks.\n\nPeople who can't find you online often go to someone they can. A website puts BioPeck Clean in front of people looking for a cleaning company in Leeds, and every quote request comes straight to me with the details you need.\n\nShall I build a website?",
        "Thanks.\n\nWhen people look for a cleaning company in Leeds, a website is how they find BioPeck Clean. Every quote request comes straight to me with the details you need.\n\nShall I build a website?",
      ])
    )
    expect([
      ...offers({ ...biopeck, area: "Within 20 miles of home" }),
    ]).toContain(
      "Thanks.\n\nPeople who can't find you online often go to someone they can. A website puts BioPeck Clean in front of people looking for a cleaning company, and every quote request comes straight to me with the details you need.\n\nShall I build a website?"
    )
    expect([...offers({ ...biopeck, industry: null, picked: true })]).toEqual(
      expect.arrayContaining([
        "People who can't find you online often go to someone they can. A website puts BioPeck Clean in front of people searching online, and every quote request comes straight to me with the details you need.\n\nShall I build a website?",
        "When people search online, a website is how they find BioPeck Clean. Every quote request comes straight to me with the details you need.\n\nShall I build a website?",
      ])
    )
    expect(
      [...offers({ industry: { name: "Electrician", category: null } })].join()
    ).toContain("people looking for an electrician in Leeds")
    // #687: the category names the business, and the town is read past "Based in".
    expect(
      [
        ...offers({
          industry: {
            name: "Domestic and end of tenancy cleaning",
            category: "cleaning",
          },
          area: "Based in Stockport",
        }),
      ].join()
    ).toContain("people looking for a cleaning company in Stockport")
    expect(
      [...offers({ industry: { name: "Removals", category: "trades" } })].join()
    ).toContain("people looking for a removals business in Leeds")
  })

  it("asks what a quote needs in words, without the website", () => {
    for (const org of ORGS) {
      const asked = question("quote_form", voice({ org }))
      expect(asked).toMatch(/quote/)
      expect(asked).toContain("?")
      expect(asked).not.toMatch(/website|site/i)
    }
  })

  it("speaks of the draft in the first person, whatever the pronouns", () => {
    for (const org of ORGS) {
      for (const pronouns of ["he_him", "she_her", "they_them"] as const) {
        const text = question("build_for_me", voice({ org, pronouns }))
        expect(text).toContain("Shall I build a website?")
        expect(text).not.toMatch(/\b(He|She|They) can have\b/)
      }
    }
  })

  it("adjusts the tone: professional only drops exclamation marks, casual contracts", () => {
    expect(say(voice({ tone: "friendly" }), "Lovely!")).toBe("Lovely!")
    expect(
      say(voice({ tone: "professional" }), "Lovely! I'll check it's there.")
    ).toBe("Lovely. I'll check it's there.")
    expect(
      say(voice({ tone: "casual" }), "Would you like me to build it?")
    ).toBe("Want me to build it?")
  })

  it("contracts a model's words in the casual tone, and only before a past participle for I have", () => {
    const casual = voice({ org: ORGS[0], tone: "casual" })
    expect(
      say(
        casual,
        "I have started building the website now. I will let you know once it is ready."
      )
    ).toBe(
      "I've started building the website now. I'll let you know once it's ready."
    )
    expect(say(casual, "I have a van and you are on the list.")).toBe(
      "I have a van and you're on the list."
    )
    expect(
      say(voice({ org: ORGS[0], tone: "friendly" }), "I have started.")
    ).toBe("I have started.")
  })

  it("opens with text only: a greeting by first name, the plan, and what the business does", () => {
    const seen = new Set<string>()
    for (const org of ORGS) {
      const parts = opening(start({ orgId: org }))
      expect(parts).toHaveLength(1)
      const text = (parts[0] as { type: string; text: string }).text
      expect(parts[0]?.type).toBe("text")
      expect(text).toContain("Probe")
      expect(text).not.toContain("Probe Owner")
      expect(text).toContain(BUSINESS)
      // Who the assistant is and what it takes on; no website offer yet.
      expect(text).toMatch(/I'm your new business assistant/)
      expect(text).toMatch(/quotes/)
      expect(text).not.toMatch(/website/)
      // The first question asks for the work and the exclusions.
      expect(text).toMatch(/don't take on|rather not do|turn down/)
      expect(text).not.toMatch(/[—–]|\bReme\b/)
      // Two paragraphs, the question its own.
      expect(text.split("\n\n")).toHaveLength(2)
      expect(text.split("\n\n")[1]).toContain(BUSINESS)
      expect(text).not.toContain("**")
      seen.add(text)
      // No name from the sign-in: no stray comma or space before it.
      const nameless = (
        opening(start({ orgId: org, ownerName: "" }))[0] as { text: string }
      ).text
      expect(nameless).not.toMatch(/ ,| {2}/)
    }
    expect(seen.size).toBeGreaterThanOrEqual(2)
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

  it("is one step of six questions, each with its own text, after the website question", () => {
    const input = tray()
    expect(input.questions.map((q) => q.id)).toEqual([
      "logo",
      "palette",
      "lettering",
      "arrangement",
      "photos",
      "pages",
    ])
    expect(input.questions.every((q) => q.question)).toBe(true)
    expect(input.questions.map((q) => q.visual)).toEqual([
      "logo",
      "palette",
      "font_pair",
      "layout",
      "photos",
      "text",
    ])
    // The logo and photos pages: upload or create, never skipped.
    const [logo, photos] = ["logo", "photos"].map((id) =>
      input.questions.find((q) => q.id === id)
    )
    expect(logo?.card).toMatchObject({ skippable: false, other: null })
    expect(logo?.card.options.map((o) => o.id)).toEqual(["upload", "create"])
    expect(logo?.upload?.max_files).toBe(1)
    expect(photos?.card.skippable).toBe(false)
    expect(photos?.upload?.max_files).toBe(12)
    expect(logo?.held).toBeUndefined()
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
      // Lettering: the industry's four fitted pairs first, then all eight.
      const lettering = input.questions.find((q) => q.id === "lettering")
      expect(lettering?.card.initial).toEqual(
        tableStart(category as never).fonts
      )
      expect(ids(input, "lettering")).toHaveLength(FONT_PAIRS.length)
      // Every palette is offered; calm ones lead, four shown.
      const palette = input.questions.find((q) => q.id === "palette")?.card
      expect(palette?.initial).toHaveLength(4)
      expect(ids(input, "palette")).toHaveLength(PALETTES.length)
      expect(ids(input, "palette").slice(0, 6)).toEqual([
        ...(palette?.initial ?? []),
        ...ids(input, "palette").slice(4, 6),
      ])
      for (const id of ids(input, "palette").slice(0, CALM_PALETTES.length)) {
        expect(CALM_PALETTES).toContain(id)
      }
    }
  })

  it("orders the calm palettes by org, the same after a reload", () => {
    const first = (orgId: string) =>
      tray({ orgId }).questions.find((q) => q.id === "palette")?.card.initial
    expect(first(ORG)).toEqual(first(ORG))
    expect(first(ORG)).not.toEqual(
      first("7b1c9e2a-0d3f-4a6b-8c5e-1f2a3b4c5d6e")
    )
  })

  it("shows a held palette among the four, ticked", () => {
    const outside = PaletteId.options.find(
      (id) => !tray().questions[1]?.card.initial?.includes(id)
    )
    const held = tray({
      facts: [...heldBefore(), { key: "site.palette", value: { id: outside } }],
    }).questions[1]?.card
    expect(held?.initial).toContain(outside)
    expect(held?.preselected).toEqual([outside])
  })

  it("shows layouts that differ, and the pair's faces and the layout's variants as visuals", () => {
    const input = tray()
    const layouts =
      input.questions
        .find((q) => q.id === "arrangement")
        ?.card.options.map((o) => o.visual) ?? []
    const looks = layouts.map((v) => JSON.stringify(v))
    expect(new Set(looks).size).toBe(looks.length)
    for (const o of input.questions[2]?.card.options ?? []) {
      expect(o.visual).toMatchObject({ kind: "font_pair" })
    }
    for (const o of input.questions[1]?.card.options ?? []) {
      expect(o.visual).toMatchObject({ kind: "swatches" })
    }
  })

  it("opens on the start chosen for the business, its look in the owner's words", () => {
    const designStart = {
      directions: [
        { type: "emblem", style: "retro" },
        { type: "lockup", style: "hand_drawn" },
        { type: "icon", style: "geometric" },
      ],
      fonts: [
        "syne_jakarta",
        "newsreader_inter",
        "dmsans_fraunces",
        "outfit_figtree",
      ],
    } as const
    const input = tray({
      designStart: {
        directions: [...designStart.directions],
        fonts: [...designStart.fonts],
      },
      prepared: {
        services_phrase: "your tree work",
        logo_look: "a neatly pruned tree",
      },
    })
    expect(input.questions[0]?.start).toEqual({
      directions: designStart.directions,
      description: "a neatly pruned tree",
    })
    const lettering = input.questions.find((q) => q.id === "lettering")
    expect(lettering?.card.initial).toEqual(designStart.fonts)
    expect(lettering?.suggested).toBe("syne_jakarta")
    expect(lettering?.card.preselected).toEqual(["syne_jakarta"])
    // Without one stored, the industry's table, and no look.
    expect(tray().questions[0]?.start).toEqual({
      directions: tableStart("cleaning").directions,
      description: "",
    })
  })

  it("opens ticked where the org already answered", () => {
    const [palette] = ids(tray(), "palette")
    const input = tray({
      facts: [
        ...heldBefore(),
        { key: "site.palette", value: { id: palette as never } },
      ],
    })
    expect(input.questions[1]?.card.preselected).toEqual([palette])
    // One not answered yet opens on its first option, kept with Looks good.
    expect(input.questions[2]?.card.preselected).toEqual(
      ids(input, "lettering").slice(0, 1)
    )
    // The logo's two ways are quick answers, neither picked; photos with
    // none held open on making them.
    expect(input.questions[0]?.card.preselected).toEqual([])
    expect(input.questions[4]?.card.preselected).toEqual(["create"])
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
      undefined,
      "warm greys and brass",
      "a quiet serif",
      "airy",
      undefined,
      undefined,
    ])
    // Own words tick nothing; pages, a card of many, opens on the usual ones.
    for (const id of ["palette", "lettering", "arrangement"])
      expect(
        input.questions.find((q) => q.id === id)?.card.preselected
      ).toEqual([])
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
      undefined,
      code,
      undefined,
      undefined,
      undefined,
      "home, fees",
    ])
  })

  it("opens the logo and photos pages on what the org holds", () => {
    const photo = {
      id: "1d9e0f10-2131-4a2b-9c3d-4e5f60718293",
      name: "kitchen.jpg",
      content_type: "image/jpeg" as const,
      bytes: 90_000,
      use: "hero" as const,
    }
    const unread = { ...photo, id: "2d9e0f10-2131-4a2b-9c3d-4e5f60718293" }
    const { use: _use, ...plain } = unread
    const input = tray({
      facts: [
        ...heldBefore(),
        { key: "media.uploads", value: { items: [LOGO, photo, plain] } },
      ],
    })
    const held = (id: string) => input.questions.find((q) => q.id === id)?.held
    expect(held("logo")).toEqual([LOGO])
    // A photo the review found no use for is not held.
    expect(held("photos")).toEqual([photo])
  })

  const card = () =>
    onboardingStep(start({ facts: heldBefore() }), counter())[1] as ToolPart
  const input = () => AskDesignInput.parse(card().input)
  // The logo page has kept its logo; `held` replaces what the org holds.
  const pick = (
    answers: Record<string, unknown>,
    skip_all = false,
    held: FactValue[] = [UPLOADS as FactValue]
  ) => cardAnswer(card(), { answers, skip_all }, [], held)
  const PAGES_ANSWERED = {
    logo: { logo: LOGO },
    photos: { photos: [], create: true },
  }

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
      ...PAGES_ANSWERED,
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

  it("shows four letterings first from four moods, never two title fonts alike", () => {
    for (const category of [...INDUSTRIES.map((i) => i.id), null]) {
      const shown =
        tray({ facts: heldBefore(category) }).questions.find(
          (q) => q.id === "lettering"
        )?.card.initial ?? []
      const pairs = shown.map((id) => FONT_PAIRS.find((p) => p.id === id))
      expect(shown).toHaveLength(4)
      expect(new Set(pairs.map((p) => p?.mood)).size).toBe(4)
      expect(new Set(pairs.map((p) => p?.display.family)).size).toBe(4)
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
        ...PAGES_ANSWERED,
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

  it("takes a palette read from a picture as the brand colour, its name and stops kept", () => {
    const { paper, tint, primary, ink } = PALETTES[0] as (typeof PALETTES)[0]
    const stops = { paper, tint, primary, ink }
    expect(
      pick({ palette: { palette: { name: "Clay van", stops } } })
    ).toMatchObject({
      facts: [
        {
          key: "site.palette",
          value: {
            id: "custom",
            brand: primary,
            custom: `Clay van: paper ${paper}, tint ${tint}, primary ${primary}, ink ${ink}`,
          },
        },
      ],
    })
    // Only the palette question takes one.
    expect(
      pick({ lettering: { palette: { name: "Clay van", stops } } })
    ).toBeNull()
    // After a reload the tray shows it by name, and sending that back keeps it.
    const read = (
      pick({ palette: { palette: { name: "Clay van", stops } } }) as {
        facts: FactValue[]
      }
    ).facts
    expect(
      tray({ facts: [...heldBefore(), ...read] }).questions[1]?.card.own
    ).toBe("Clay van")
    expect(
      pick({ palette: { own: "Clay van" } }, false, [
        UPLOADS as FactValue,
        ...read,
      ])
    ).toMatchObject({ facts: [] })
  })

  it("takes the logo and photos the org holds, and nothing else on their pages", () => {
    const photo = { ...LOGO, id: "1d9e0f10-2131-4a2b-9c3d-4e5f60718293" }
    const { use: _use, ...sent } = photo
    const both = {
      key: "media.uploads",
      value: { items: [LOGO, sent] },
    } as FactValue
    expect(pick({ logo: { logo: LOGO } })).toMatchObject({ facts: [] })
    // Not kept as the logo, or not held at all.
    expect(pick({ logo: { logo: sent } }, false, [both])).toBeNull()
    expect(pick({ logo: { logo: LOGO } }, false, [])).toBeNull()
    expect(
      pick({ photos: { photos: [sent], create: false } }, false, [both])
    ).toMatchObject({ facts: [] })
    expect(pick({ photos: { photos: [sent], create: true } })).toBeNull()
    expect(pick({ photos: { photos: [], create: true } })).toMatchObject({
      facts: [],
    })
    // Their cards' options are ways in, never answers.
    expect(pick({ logo: { choice: "create" } })).toBeNull()
    expect(pick({ photos: { choice: "upload" } })).toBeNull()
    expect(pick({ logo: { skipped: true } })).toBeNull()
    expect(pick({ palette: { logo: LOGO } })).toBeNull()
  })

  it("reads a typed option's label as its pick, but never a logo or photos way in", () => {
    const [palette] = ids(input(), "palette")
    const named = PALETTES.find((p) => p.id === palette)?.label ?? ""
    expect(trayOption(card(), named)).toBe(palette)
    expect(trayOption(card(), "No, create one for me")).toBeNull()
    expect(trayOption(card(), "Yes, I have photos")).toBeNull()
  })

  it("refuses a finished tray with no logo, answered or held", () => {
    expect(pick({}, true, [])).toBeNull()
    expect(pick({ logo: { logo: LOGO } }, true)).toMatchObject({
      settled: true,
    })
    expect(pick({}, true)).toMatchObject({ settled: true })
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
      picked: true,
    })
    expect(
      designAnswer(input(), { answers: {}, skip_all: true }, [
        UPLOADS,
        { key: "site.direction", value: { id: "calm_daylight" } },
      ])
    ).toEqual({ kind: "design", facts: [], settled: true, picked: true })
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
    expect(currentStep(finished)?.id).toBe("build")
    // Four held answers and a logo with the tray never closed: still done.
    const four: FactValue[] = [
      ...ALL_BEFORE("design"),
      { key: "site.palette", value: { id: "ocean" } },
      { key: "site.font", value: { id: "sora_manrope" } },
      { key: "site.direction", value: { id: "fresh_modern" } },
      { key: "site.pages", value: { ids: ["home", "quote"] } },
    ]
    expect(designDone(start({ facts: four }))).toBe(false)
    expect(designDone(start({ facts: [...four, UPLOADS as FactValue] }))).toBe(
      true
    )
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

describe("the assistant card's name ideas", () => {
  const ideas = (o: Onboarding) =>
    AskDetailsInput.parse(detailsCard("assistant", o, counter()).input).ideas

  it("carries the names written for the business once they are ready, the house ones until then", () => {
    expect(ideas(start())).toEqual([...NAME_IDEAS])
    const prepared = {
      services_phrase: "your cleans",
      assistant_names: ["Poppy", "Theo"],
    }
    expect(ideas(start({ prepared }))).toEqual(["Poppy", "Theo"])
  })

  it("opens on she/her, the first she/her face and professional with no name, the org's own picks first", () => {
    const prefill = (o: Onboarding) =>
      AskDetailsInput.parse(detailsCard("assistant", o, counter()).input)
        .prefill
    expect(prefill(start())).toEqual([
      { key: "assistant.pronouns", value: { id: "she_her" } },
      { key: "assistant.avatar", value: { id: "she_1" } },
      { key: "assistant.tone", value: { id: "professional" } },
    ])
    const named = start({
      facts: [{ key: "assistant.name", value: { name: "Maya" } }],
    })
    expect(prefill(named).map((fact) => fact.value)).toEqual([
      { name: "Maya" },
      { id: "she_her" },
      { id: "she_1" },
      { id: "professional" },
    ])
  })
})
