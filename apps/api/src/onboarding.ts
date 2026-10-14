import {
  AskChoiceInput,
  AskChoiceOutput,
  AskDetailsInput,
  AskDetailsOutput,
  AskFactInput,
  AskFactOutput,
  AskUploadInput,
  AskUploadOutput,
  type ChoiceStep,
  DETAILS_KEYS,
  type DetailsStep,
  FactValue,
  type FactValueKey,
  FIXED_PAGES,
  FONTS,
  INDUSTRIES,
  PAGES,
  PALETTES,
  PaletteId,
  PRONOUNS,
  type QuoteField,
  type RequestChangeOutput,
  ReviewQuoteFormInput,
  ReviewQuoteFormOutput,
  TEMPLATES,
  type TemplateId,
  TONES,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES,
  UPLOAD_TYPES,
} from "@workspace/contracts"
import type { Part, ToolPart } from "./chat.ts"
import type { JevDecision } from "./jev.ts"
import {
  chose,
  hash,
  manualEnd,
  notStarted,
  opener,
  photos,
  question,
  quoteForm,
  type RetryReason,
  retry,
  started,
  type Voice,
} from "./onboarding-copy.ts"

/**
 * The onboarding script as pure functions: which step comes next, what it
 * says, and what an answer to it means. Progress is what exists, never a
 * counter: the facts the org holds, and the cards this conversation closed
 * without a fact (a skip, the photos, the builder question). A step whose
 * fact exists is passed over, so a returning owner is asked only for what
 * is missing. `chat.ts` does the reading and writing.
 */

/**
 * A step is its fact's key for an `ask_fact`, its `ChoiceStep` for an
 * `ask_choice`, its `DetailsStep` for an `ask_details`.
 */
export type StepId =
  | "business.name"
  | "business.offerings"
  | "service_area.text"
  | "business.audience"
  | "business.proof"
  | "owner.preferred_name"
  | ChoiceStep
  | DetailsStep
  | "upload"
  | "quote_form"
  | "build"

/** The first build's goal: the owner's details are in the facts. */
export const ONBOARDING_GOAL = "Build my website from the details I gave you."

/**
 * The facts an owner may skip; every other one the site or the assistant
 * needs. The slogan and how a job runs are never asked: the builder drafts
 * them.
 */
export const SKIPPABLE: readonly FactValueKey[] = [
  "business.audience",
  "business.proof",
]

export type Held = { key: string; value: unknown }

/** What the conversation's cards say, read by `readScript`. */
export type Progress = {
  /** Steps closed without a fact: a skip, the photos, the builder answer. */
  passed: readonly string[]
  /** Whether a build was started or offered and answered in this conversation. */
  offered: boolean
  /** The answer to "use the builder yourself?", once given. */
  builder: boolean | null
  /**
   * Steps whose latest card is no longer waiting: answered, skipped, or
   * talked over by a typed message and not asked again. A card talked over
   * is asked again whenever the typed reply did not settle it, by the script
   * (`again`) or by the planner (`unanswered`), so a talked-over card that
   * stays closed was settled. A quote form the owner asked to change is not
   * closed: a new proposal follows it.
   */
  closed: readonly string[]
}

export type Onboarding = Progress & {
  /** Picks each line's wording, so a reload reads the same words. */
  orgId: string
  facts: readonly Held[]
  /** `orgs.name`, for when the business name is not a fact. */
  orgName: string
  /** The session's name for the owner, or "". */
  ownerName: string
  /** The session's email: the contact card's starting email, and a stand-in for a missing name. */
  ownerEmail?: string
  /**
   * How often each fact has been asked here, by a card or a planned question
   * (`askedSoFar`), so the script never asks an optional one twice.
   */
  asked?: Readonly<Record<string, number>>
  /** Business-specific lines written in the background, once they are ready. */
  prepared?: Prepared | null
}

/** What the background call writes for later steps (`onboarding-prepare.ts`). */
export type Prepared = {
  /** The photo question for this business, such as the fleet for a chauffeur firm. */
  photo_question: string
  /** The business's services as a short phrase, such as "your wedding cars". */
  services_phrase: string
}

/** Whether the script has finished: the build is under way or the owner went their own way. */
export const ended = (p: Progress) =>
  p.offered || p.builder !== null || p.closed.includes("manual_builder")

type Values = { [F in FactValue as F["key"]]: F["value"] }

/** A fact's value by key, when the stored value still parses. */
export function factValue<K extends FactValueKey>(
  facts: readonly Held[],
  key: K
): Values[K] | undefined {
  const held = facts.find((f) => f.key === key)
  const parsed = held && FactValue.safeParse({ key, value: held.value })
  return parsed?.success
    ? (parsed.data.value as unknown as Values[K])
    : undefined
}

export const has = (o: Onboarding, key: FactValueKey) =>
  o.facts.some((f) => f.key === key)
export const mode = (o: Onboarding) =>
  factValue(o.facts, "site.build_mode")?.mode

const label = (list: readonly { id: string; label: string }[], id?: string) =>
  list.find((each) => each.id === id)?.label ?? null

export function voiceOf(o: Onboarding): Voice {
  const template = factValue(o.facts, "site.template")
  const palette = factValue(o.facts, "site.palette")
  return {
    org: o.orgId,
    business: factValue(o.facts, "business.name")?.name ?? o.orgName,
    owner: factValue(o.facts, "owner.preferred_name")?.name ?? o.ownerName,
    assistant: factValue(o.facts, "assistant.name")?.name ?? "",
    pronouns: factValue(o.facts, "assistant.pronouns")?.id ?? "they_them",
    tone: factValue(o.facts, "assistant.tone")?.id ?? "friendly",
    industry: factValue(o.facts, "business.industry") ?? null,
    offering: factValue(o.facts, "business.offerings")?.items[0] ?? null,
    template: template?.custom ? null : label(TEMPLATES, template?.id),
    palette: label(PALETTES, palette?.id),
    ownColour: palette?.brand ?? palette?.custom ?? null,
    services: o.prepared?.services_phrase ?? null,
    photoQuestion: o.prepared?.photo_question ?? null,
  }
}

type Option = AskChoiceInput["options"][number]
const plain = (list: readonly { id: string; label: string; hint?: string }[]) =>
  list.map(
    (each): Option => ({
      id: each.id,
      label: each.label,
      hint: each.hint ?? null,
      visual: null,
    })
  )

const other = (placeholder: string) => ({
  label: "Something else",
  placeholder,
})

/**
 * Palettes that look alike: blues, greens, warm, reds, purples, neutrals.
 * The four shown first take one from each of four, so never four blues.
 */
const FAMILIES: readonly (readonly PaletteId[])[] = [
  ["ocean", "classic_blue", "harbour", "royal"],
  ["lagoon", "forest", "sage", "mint", "meadow"],
  ["sunset", "mocha"],
  ["cardinal", "berry", "burgundy"],
  ["midnight", "damson", "ultra_violet"],
  ["graphite", "onyx", "pebble"],
]
const family = (id: PaletteId) => FAMILIES.findIndex((f) => f.includes(id))

/**
 * The four palettes the card shows first: the pool in an order seeded by
 * the org id, taking one per family. The same org sees the same four after
 * a reload; another org likely sees another four.
 */
export function firstPalettes(org: string): PaletteId[] {
  const seeded = [...PaletteId.options].sort(
    (a, b) => hash(`${org}|palette|${a}`) - hash(`${org}|palette|${b}`)
  )
  const shown: PaletteId[] = []
  for (const id of seeded) {
    if (shown.length === 4) break
    if (!shown.some((each) => family(each) === family(id))) shown.push(id)
  }
  return shown
}

/** The script's quote form: what any business needs, for the owner to keep or change. */
export const DEFAULT_QUOTE_FIELDS = [
  {
    key: "job",
    label: "What do you need?",
    type: "textarea",
    required: true,
    hint: null,
    options: null,
  },
  {
    key: "when",
    label: "When do you need it?",
    type: "date",
    required: false,
    hint: null,
    options: null,
  },
] as const satisfies readonly QuoteField[]

/** The pages ticked when the card opens. */
const DEFAULT_PAGES = ["home", "services", "about", "contact", "quote"]

/** Each card's options, from the contracts' lists, so an answer is checked against the same ids. */
const CHOICES: Record<
  ChoiceStep,
  (o: Onboarding) => Omit<AskChoiceInput, "step">
> = {
  industry: () => ({
    options: plain(INDUSTRIES),
    multiple: false,
    preselected: [],
    other: other("Tell me in your own words"),
    skippable: false,
  }),
  pronouns: () => ({
    options: plain(PRONOUNS),
    multiple: false,
    preselected: [],
    other: null,
    skippable: false,
  }),
  tone: () => ({
    options: plain(TONES),
    multiple: false,
    preselected: [],
    other: null,
    skippable: false,
  }),
  build_for_me: () => ({
    options: plain([
      { id: "yes", label: "Yes, build it for me" },
      { id: "skip", label: "Skip" },
    ]),
    multiple: false,
    preselected: [],
    other: null,
    skippable: false,
  }),
  manual_builder: () => ({
    options: plain([
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ]),
    multiple: false,
    preselected: [],
    other: null,
    skippable: false,
  }),
  template: () => ({
    options: TEMPLATES.map((t) => ({
      id: t.id,
      label: t.label,
      hint: t.hint,
      visual: { kind: "template" as const, id: t.id },
    })),
    multiple: false,
    preselected: [],
    other: other("Describe the layout you have in mind"),
    skippable: false,
  }),
  palette: (o) => ({
    options: PALETTES.map((p) => ({
      id: p.id,
      label: p.label,
      hint: p.hint ?? null,
      visual: { kind: "swatches" as const, colors: p.swatches.slice(0, 4) },
    })),
    multiple: false,
    preselected: [],
    other: {
      label: "Your own colour",
      placeholder: "A colour code, or describe your colours",
    },
    skippable: false,
    initial: firstPalettes(o.orgId),
    color: true,
  }),
  font: () => ({
    options: FONTS.map((f) => ({
      id: f.id,
      label: f.label,
      hint: f.hint,
      visual: { kind: "font" as const, family: f.family },
    })),
    multiple: false,
    preselected: [],
    other: other("Describe the lettering you like"),
    skippable: false,
  }),
  pages: () => ({
    options: plain(PAGES),
    multiple: true,
    preselected: DEFAULT_PAGES,
    other: other("Name any other page and what goes on it"),
    skippable: false,
  }),
}

export const call = (
  type: ToolPart["type"],
  input: unknown,
  newId: () => string
) =>
  ({ type, toolCallId: newId(), state: "input-available", input }) as ToolPart

export const text = (words: string): Part => ({
  type: "text",
  text: words,
  state: "done",
})

export const factCard = (
  o: Onboarding,
  key: FactValueKey,
  newId: () => string
) => {
  const prefill =
    key === "business.name"
      ? { key, value: { name: o.orgName } }
      : key === "owner.preferred_name"
        ? {
            key,
            value: { name: o.ownerName || (o.ownerEmail?.split("@")[0] ?? "") },
          }
        : null
  const parsed = prefill && FactValue.safeParse(prefill)
  return call(
    "tool-ask_fact",
    AskFactInput.parse({
      key,
      skippable: SKIPPABLE.includes(key),
      prefill: parsed?.success ? parsed.data.value : null,
    }),
    newId
  )
}

/**
 * A details card: the step's facts together, each one the org holds filled
 * in, and the sign-in email offered as the business's until one is held.
 */
export const detailsCard = (
  step: DetailsStep,
  o: Onboarding,
  newId: () => string
) => {
  const held = DETAILS_KEYS[step].flatMap((key) => {
    const value = factValue(o.facts, key)
    return value === undefined ? [] : [{ key, value }]
  })
  const email = FactValue.safeParse({
    key: "business.email",
    value: { address: o.ownerEmail ?? "" },
  })
  const prefill =
    step === "contact" && !has(o, "business.email") && email.success
      ? [...held, email.data]
      : held
  return call(
    "tool-ask_details",
    AskDetailsInput.parse({ step, prefill, skippable: false }),
    newId
  )
}

/**
 * A choice card from the contracts' lists. The planner may replace the
 * step's own ticks (`preselected`) and the palettes shown first (`initial`).
 */
export const choiceCard = (
  step: ChoiceStep,
  o: Onboarding,
  newId: () => string,
  over: { preselected?: string[]; initial?: string[] } = {}
) =>
  call(
    "tool-ask_choice",
    AskChoiceInput.parse({
      step,
      ...CHOICES[step](o),
      ...(over.preselected ? { preselected: over.preselected } : {}),
      ...(over.initial ? { initial: over.initial } : {}),
    }),
    newId
  )

/** The option ids a choice step's card offers. */
export const choiceIds = (step: ChoiceStep, o: Onboarding) =>
  CHOICES[step](o).options.map((each) => each.id)

/** Whether a step's card lets the owner pick more than one. */
export const choiceMultiple = (step: ChoiceStep, o: Onboarding) =>
  CHOICES[step](o).multiple

export const uploadCard = (newId: () => string) =>
  call(
    "tool-ask_upload",
    AskUploadInput.parse({
      accept: [...UPLOAD_TYPES],
      max_files: UPLOAD_MAX_FILES,
      max_bytes: UPLOAD_MAX_BYTES,
      skippable: true,
    }),
    newId
  )

type Step = {
  id: StepId
  done: (o: Onboarding) => boolean
  ask: (o: Onboarding, newId: () => string) => Part[]
}

/**
 * A fact asked with a form. An optional one is done once it has been asked,
 * by a card or by the planner in words, whatever the answer.
 */
const askFact = (key: Extract<StepId, FactValueKey>): Step => ({
  id: key,
  done: (o) =>
    has(o, key) ||
    o.passed.includes(key) ||
    (SKIPPABLE.includes(key) && (o.asked?.[key] ?? 0) > 0),
  ask: (o, newId) => [text(question(key, voiceOf(o))), factCard(o, key, newId)],
})

/** A few related facts on one card, done once every one is held. */
const askDetails = (step: DetailsStep): Step => ({
  id: step,
  done: (o) => DETAILS_KEYS[step].every((key) => has(o, key)),
  ask: (o, newId) => [
    text(question(step, voiceOf(o))),
    detailsCard(step, o, newId),
  ],
})

/** A choice step, done once its fact exists or while `applies` says it is not asked. */
const askChoice = (
  step: ChoiceStep,
  key: FactValueKey,
  applies: (o: Onboarding) => boolean = () => true
): Step => ({
  id: step,
  done: (o) => !applies(o) || has(o, key),
  ask: (o, newId) => [
    text(question(step, voiceOf(o))),
    choiceCard(step, o, newId),
  ],
})

const building = (o: Onboarding) => mode(o) === "assistant"

/**
 * The script, in order. Phase 1 the business, phase 2 the assistant, phase
 * 3 the website and its quote form, phase 4 photos, phase 5 the build.
 * "Skip" on the build question takes the manual branch instead of phases 3
 * to 5. The opener asks what the business does in words, and the planner
 * reads the answers to the open questions; the script asks the rest with a
 * card, and asks the open ones with a form when the planner cannot run. The
 * industry card comes only when the owner's words did not tell the planner.
 *
 * The photo step is the one step asked even when its fact exists, so the
 * build only ever follows a turn that wrote no fact: the orchestrator
 * snapshots facts over its own connection, and cannot see this turn's
 * uncommitted writes.
 */
export const STEPS: readonly Step[] = [
  askFact("business.offerings"),
  askFact("service_area.text"),
  askFact("business.audience"),
  askFact("business.proof"),
  askChoice("industry", "business.industry"),
  // Sign-up states it; asked only when the name it gave did not parse.
  askFact("business.name"),
  askDetails("contact"),
  askDetails("assistant"),
  askFact("owner.preferred_name"),
  askChoice("build_for_me", "site.build_mode"),
  {
    id: "manual_builder",
    done: (o) =>
      mode(o) !== "manual" ||
      o.builder !== null ||
      o.closed.includes("manual_builder"),
    ask: (o, newId) => [
      text(question("manual_builder", voiceOf(o))),
      choiceCard("manual_builder", o, newId),
    ],
  },
  askChoice("template", "site.template", building),
  askChoice("palette", "site.palette", building),
  askChoice("font", "site.font", building),
  askChoice("pages", "site.pages", building),
  {
    // The build waits for a quote form the owner reviewed or declined. The
    // question is asked in words and the planner proposes a form from the
    // answer; with no model, a typed answer gets the script's short form to
    // confirm (`defaultQuoteForm`).
    id: "quote_form",
    done: (o) =>
      !building(o) || has(o, "quote.form") || o.closed.includes("quote_form"),
    ask: (o) => [text(question("quote_form", voiceOf(o)))],
  },
  {
    id: "upload",
    done: (o) => !building(o) || o.closed.includes("upload"),
    ask: (o, newId) => [text(photos(voiceOf(o))), uploadCard(newId)],
  },
  {
    id: "build",
    done: (o) => !building(o) || o.offered,
    // Started by `chat.ts`, which turns this pending call into its outcome with `built`.
    ask: (_o, newId) => [
      call("tool-request_change", { text: ONBOARDING_GOAL }, newId),
    ],
  },
]

/** The script's quote form, for a typed answer no model could read: a short form to confirm. */
export const defaultQuoteForm = (o: Onboarding, newId: () => string) => [
  text(quoteForm(voiceOf(o))),
  call(
    "tool-review_quote_form",
    ReviewQuoteFormInput.parse({ fields: DEFAULT_QUOTE_FIELDS, note: null }),
    newId
  ),
]

/** The step the script is on, or undefined once nothing is left. */
export const currentStep = (o: Onboarding) =>
  STEPS.find((each) => !each.done(o))

/** The parts of the next step, or the manual branch's closing line once nothing is left. */
export function onboardingStep(o: Onboarding, newId: () => string): Part[] {
  const step = currentStep(o)
  if (step) return step.ask(o, newId)
  return [text(manualEnd(voiceOf(o), o.builder === true))]
}

/**
 * The first row a new org sees: the opener alone, text only, which asks
 * what the business does in words. Its answer goes to the planner, or to the
 * script's `openCard`.
 */
export const opening = (o: Onboarding): Part[] => [text(opener(voiceOf(o)))]

/**
 * The card a typed message answers when none is waiting: the step the
 * script is on, when the opener or the planner asked it in words. A form's
 * card for a fact; the script's short quote form for the quote question.
 * Never stored: a retry shows it under a new id.
 */
export function openCard(
  o: Onboarding,
  newId: () => string
): ToolPart | undefined {
  const step = currentStep(o)
  if (step?.id === "quote_form") {
    return defaultQuoteForm(o, newId)[1] as ToolPart
  }
  const key = step?.id as FactValueKey | undefined
  return key && FactValue.options.some((f) => f.shape.key.value === key)
    ? factCard(o, key, newId)
    : undefined
}

/** The build step's call, when these parts are it. */
export const buildCall = (parts: Part[]) =>
  parts.find(
    (p): p is ToolPart =>
      p.type === "tool-request_change" && p.state === "input-available"
  )

/**
 * The build step once the change answered: the call resolved as the
 * request_change card shows it, then the closing line in a step of its own,
 * so no client reads a finished call as the last step and sends again.
 */
export function built(
  o: Onboarding,
  pending: ToolPart,
  output: RequestChangeOutput,
  /** The planner's own words for a build that started. */
  said?: string
): Part[] {
  const v = voiceOf(o)
  return [
    { ...pending, state: "output-available", output },
    { type: "step-start" },
    text(
      output.outcome === "started"
        ? (said ?? started(v, has(o, "media.uploads")))
        : notStarted(v)
    ),
  ]
}

/**
 * What an answer to a step means for the script. `chose` names what the
 * assistant picked for an owner who left it to them: those facts are
 * `inferred`, and the next step says what was picked.
 */
export type Answer =
  | { kind: "facts"; facts: FactValue[]; chose?: string }
  | { kind: "passed"; step: StepId; builder?: boolean }
  | { kind: "retry"; reason: RetryReason }

/** The onboarding with an answer applied, as the next step reads it. */
export function applied(o: Onboarding, answer: Answer): Onboarding {
  if (answer.kind === "facts") {
    const keys = new Set(answer.facts.map((f) => f.key))
    return {
      ...o,
      facts: [
        ...o.facts.filter((f) => !keys.has(f.key as never)),
        ...answer.facts,
      ],
    }
  }
  if (answer.kind === "passed") {
    return {
      ...o,
      passed: [...o.passed, answer.step],
      closed: [...o.closed, answer.step],
      builder: answer.builder ?? o.builder,
    }
  }
  return o
}

/** The step a card asks, from its input. */
export function stepOf(part: ToolPart): StepId | null {
  if (part.type === "tool-ask_upload") return "upload"
  if (part.type === "tool-review_quote_form") return "quote_form"
  const input = part.input as { key?: StepId; step?: StepId } | null
  if (part.type === "tool-ask_fact") return input?.key ?? null
  if (part.type === "tool-ask_choice" || part.type === "tool-ask_details") {
    return input?.step ?? null
  }
  return null
}

const CARDS: readonly ToolPart["type"][] = [
  "tool-ask_fact",
  "tool-ask_details",
  "tool-ask_choice",
  "tool-ask_upload",
  "tool-review_quote_form",
]
export const isCard = (part: { type: string }) =>
  CARDS.includes(part.type as ToolPart["type"])

/** Each card's output schema, so a stored answer and a retry compare alike. */
export const OUTPUTS = {
  "tool-ask_fact": AskFactOutput,
  "tool-ask_details": AskDetailsOutput,
  "tool-ask_choice": AskChoiceOutput,
  "tool-ask_upload": AskUploadOutput,
  "tool-review_quote_form": ReviewQuoteFormOutput,
} as const

/**
 * The facts a details card states: only the step's own keys, each once,
 * every value a `FactValue`. Null to refuse the answer.
 */
function detailsAnswer(input: AskDetailsInput, output: unknown): Answer | null {
  const answer = AskDetailsOutput.safeParse(output)
  if (!answer.success) return null
  if (answer.data.answer === "skipped") {
    return input.skippable ? { kind: "passed", step: input.step } : null
  }
  const keys = answer.data.facts.map((f) => f.key as string)
  const allowed = DETAILS_KEYS[input.step] as readonly string[]
  if (
    new Set(keys).size !== keys.length ||
    !keys.every((key) => allowed.includes(key))
  ) {
    return null
  }
  return { kind: "facts", facts: answer.data.facts }
}

/**
 * The contact details the starter's quote form always asks, by the key or
 * the label a proposal would give them, or by an input type only they use.
 * A question about the customer's pet's name or the phone to be repaired
 * keeps its own key and label, so it passes.
 */
const CONTACT_KEYS =
  /^(your_|customer_|client_|full_|first_|last_|contact_)?(name|email|email_address|e_mail|phone|phone_number|telephone|tel|mobile|mobile_number|contact|contact_number|contact_details)$/
const CONTACT_LABELS =
  /^(your |full |first |last |contact )*(name|e-?mail( address)?|phone( number)?|telephone( number)?|mobile( number)?|contact (number|details))\??$/i

/** The fields of a quote form that repeat the contact details. */
export const contactFields = (fields: readonly QuoteField[]) =>
  fields.filter(
    (f) =>
      f.type === "tel" ||
      f.type === "email" ||
      CONTACT_KEYS.test(f.key) ||
      CONTACT_LABELS.test(f.label.trim())
  )

// ponytail: a keyword table, not a classifier. Anything it misses keeps the
// owner's words in `custom`, which the Developer reads.
const LOOKS: [RegExp, TemplateId][] = [
  [/bold|dark|strong|contrast|punchy|striking/i, "bold"],
  [/modern|minimal|light|simple|airy|photo|image|clean/i, "modern"],
]
const closestTemplate = (words: string): TemplateId =>
  LOOKS.find(([pattern]) => pattern.test(words))?.[1] ?? "classic"

/** The colour picker's answer. Anything else starting with `#` is a bad code, not words. */
const HEX = /^#[0-9a-f]{6}$/i

/**
 * The palette a custom answer sets: a colour code is the brand colour,
 * anything else the owner's words. A code that is not `#rrggbb` is refused.
 */
function ownPalette(words: string) {
  const said = words.trim()
  if (HEX.test(said)) return { id: "custom", brand: said.toLowerCase() }
  return said.startsWith("#") ? null : { id: "custom", custom: words }
}

/**
 * The facts a choice sets, or null when the answer does not fit the card:
 * an id it did not offer, more than one where one is asked, the owner's
 * own words where it has no Other, or nothing at all. Every value then goes
 * through `FactValue`, the contracts' check of each id.
 */
export function chosen(
  input: AskChoiceInput,
  ids: string[],
  words: string | null
): Answer | null {
  if (
    !ids.every((each) => input.options.some((o) => o.id === each)) ||
    (!input.multiple && ids.length > 1) ||
    (words !== null && input.other === null) ||
    (ids.length === 0 && words === null)
  ) {
    return null
  }
  const [id] = ids
  const custom = words === null ? {} : { custom: words }
  const fact = (key: FactValueKey, value: unknown): Answer | null => {
    const parsed = FactValue.safeParse({ key, value })
    return parsed.success ? { kind: "facts", facts: [parsed.data] } : null
  }
  switch (input.step) {
    case "industry":
      return fact("business.industry", {
        name: words ?? label(INDUSTRIES, id),
        category: id ?? null,
      })
    case "pronouns":
      return fact("assistant.pronouns", { id })
    case "tone":
      return fact("assistant.tone", { id })
    case "build_for_me":
      return fact("site.build_mode", {
        mode: id === "yes" ? "assistant" : "manual",
      })
    case "manual_builder":
      return { kind: "passed", step: "manual_builder", builder: id === "yes" }
    case "template":
      return fact("site.template", {
        id: id ?? closestTemplate(words ?? ""),
        ...custom,
      })
    case "palette":
      return fact("site.palette", words === null ? { id } : ownPalette(words))
    case "font":
      return fact(
        "site.font",
        words === null ? { id } : { id: "custom", ...custom }
      )
    case "pages":
      return fact("site.pages", {
        ids: PAGES.map((p) => p.id).filter(
          (page) =>
            ids.includes(page) ||
            (FIXED_PAGES as readonly string[]).includes(page)
        ),
        ...custom,
      })
  }
}

/**
 * An answer from a card, or null to refuse it. `uploads` is the org's
 * `media.uploads`: a photo answer names only ids it holds.
 */
export function cardAnswer(
  part: ToolPart,
  output: unknown,
  uploads: readonly { id: string }[]
): Answer | null {
  const step = stepOf(part)
  if (!step) return null
  if (part.type === "tool-ask_details") {
    const input = AskDetailsInput.safeParse(part.input)
    return input.success ? detailsAnswer(input.data, output) : null
  }
  if (part.type === "tool-ask_fact") {
    const answer = AskFactOutput.safeParse(output)
    const { key } = part.input as AskFactInput
    if (!answer.success) return null
    if (answer.data.answer === "skipped") {
      return SKIPPABLE.includes(key) ? { kind: "passed", step } : null
    }
    return answer.data.fact.key === key
      ? { kind: "facts", facts: [answer.data.fact] }
      : null
  }
  if (part.type === "tool-ask_choice") {
    const answer = AskChoiceOutput.safeParse(output)
    const input = AskChoiceInput.safeParse(part.input)
    if (!answer.success || !input.success) return null
    if (answer.data.answer === "skipped") {
      return input.data.skippable ? { kind: "passed", step } : null
    }
    return chosen(input.data, answer.data.ids, answer.data.other)
  }
  if (part.type === "tool-review_quote_form") {
    const answer = ReviewQuoteFormOutput.safeParse(output)
    if (!answer.success) return null
    // Changes are the owner's words for the next proposal, so no fact yet.
    if (answer.data.answer === "changes") return { kind: "facts", facts: [] }
    if (contactFields(answer.data.fields).length > 0) return null
    const fact = FactValue.safeParse({
      key: "quote.form",
      value: { fields: answer.data.fields },
    })
    return fact.success ? { kind: "facts", facts: [fact.data] } : null
  }
  const answer = AskUploadOutput.safeParse(output)
  if (!answer.success) return null
  if (answer.data.answer === "skipped") return { kind: "passed", step }
  return answer.data.assets.every((a) => uploads.some((u) => u.id === a.id))
    ? { kind: "passed", step }
    : null
}

/** The owner's words, trimmed of the punctuation people end a reply with. */
const norm = (words: string) =>
  words
    .trim()
    .toLowerCase()
    .replace(/[.!?"']+$/, "")
    .trim()

const YES =
  /^(y|yes|yeah|yep|yup|sure|ok|okay|please|of course|go ahead|definitely|absolutely|sounds good|why not|do it|build it)\b/
const NO =
  /^(n|no|nope|nah|not now|not really|no thanks|skip|maybe later|later|myself|i'?ll do it)\b/
const SKIP =
  /^(skip|no|nope|nah|none|pass|not now|later|no thanks|n\/a|(i )?don'?t have (any|one)|i have none|nothing)\b/

/** Yes, no, or neither, from a typed reply. */
export function yesNo(words: string): boolean | null {
  const said = norm(words)
  if (YES.test(said)) return true
  if (NO.test(said)) return false
  return null
}

/** Whether a typed reply passes over a skippable step. */
export const saysSkip = (words: string) => SKIP.test(norm(words))

/** A typed phone number in E.164, if it can be one. */
const e164 = (words: string) =>
  words.replace(/[\s().-]/g, "").replace(/^00/, "+")

/** The field each text-asked fact keeps its words in. */
const FIELD: Partial<Record<FactValueKey, string>> = {
  "business.name": "name",
  "business.audience": "text",
  "business.proof": "text",
  "service_area.text": "text",
  "assistant.name": "name",
  "owner.preferred_name": "name",
  "business.email": "address",
}

function typedFact(key: FactValueKey, words: string): Answer {
  const said = words.trim()
  const value =
    key === "business.phone"
      ? { e164: e164(said) }
      : key === "business.offerings"
        ? {
            items: said
              .split(/[,;\n]+/)
              .map((item) =>
                item.replace(/^\s*(?:[-*•]|and\b|or\b)\s*/i, "").trim()
              )
              .filter(Boolean),
          }
        : FIELD[key]
          ? { [FIELD[key]]: said }
          : null
  const parsed = value && FactValue.safeParse({ key, value })
  if (parsed?.success) return { kind: "facts", facts: [parsed.data] }
  if (key === "business.phone") return { kind: "retry", reason: "phone" }
  if (key === "business.email") return { kind: "retry", reason: "email" }
  return {
    kind: "retry",
    reason: said.length > 80 ? "long" : "unclear",
  }
}

/** A typed reply to a choice card: an option by its label or id, or the owner's own words. */
function typedChoice(input: AskChoiceInput, words: string): Answer {
  if (input.step === "build_for_me" || input.step === "manual_builder") {
    const yes = yesNo(words)
    if (yes === null) return { kind: "retry", reason: "yes_no" }
    const id = yes ? "yes" : input.step === "build_for_me" ? "skip" : "no"
    return chosen(input, [id], null) ?? { kind: "retry", reason: "yes_no" }
  }
  const find = (piece: string) =>
    input.options.find(
      (o) =>
        norm(o.label) === piece ||
        o.id === piece ||
        o.id.replace(/_/g, " ") === piece ||
        norm(o.label).split("/").includes(piece)
    )?.id
  const said = norm(words)
  const pieces = input.multiple
    ? said.split(/\s*(?:,|;|\n|\band\b)\s*/).filter(Boolean)
    : [said]
  const ids = pieces.flatMap((p) => find(p) ?? [])
  const rest = input.multiple
    ? pieces.filter((p) => !find(p)).join(", ")
    : ids.length > 0
      ? ""
      : words.trim()
  const answer = chosen(input, ids, rest && input.other ? rest : null)
  if (answer && (!rest || input.other)) return answer
  if (!input.other) return { kind: "retry", reason: "choice" }
  return { kind: "retry", reason: words.length > 200 ? "long" : "unclear" }
}

/** An email address and a number in E.164 typed over the contact card, as far as plain matching finds them. */
function typedContact(words: string): Answer {
  const facts = [
    FactValue.safeParse({
      key: "business.email",
      value: { address: words.match(/[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+/)?.[0] },
    }),
    FactValue.safeParse({
      key: "business.phone",
      value: { e164: e164(words.match(/\+?[\d\s().-]{7,}\d/)?.[0] ?? "") },
    }),
  ].flatMap((f) => (f.success ? [f.data] : []))
  if (facts.length > 0) return { kind: "facts", facts }
  // A number with no country code is the likeliest miss, so say so.
  return {
    kind: "retry",
    reason: /\d{6}/.test(words.replace(/\D/g, "")) ? "phone" : "details",
  }
}

/**
 * What a typed reply means for the card it overtook. Text asks take the
 * words as the value; choice cards match an option or take the owner's own
 * words when the card has an Other; the photo card takes a skip; the contact
 * card takes an email and a full number. Anything else asks again, with a
 * line that says what was missing. The planner reads the owner's words
 * first whenever it can; this is the script's reading without a model.
 */
export function typedAnswer(part: ToolPart, words: string): Answer {
  const step = stepOf(part)
  // Without a model nothing can read a proposal's changes from words.
  if (step === "quote_form") return { kind: "retry", reason: "quote" }
  if (step === "contact") return typedContact(words)
  if (!step || step === "assistant") {
    return { kind: "retry", reason: step ? "details" : "unclear" }
  }
  if (part.type === "tool-ask_upload") {
    return saysSkip(words)
      ? { kind: "passed", step }
      : { kind: "retry", reason: "upload" }
  }
  if (part.type === "tool-ask_choice") {
    const input = AskChoiceInput.safeParse(part.input)
    return input.success
      ? typedChoice(input.data, words)
      : { kind: "retry", reason: "unclear" }
  }
  const { key } = part.input as AskFactInput
  if (SKIPPABLE.includes(key) && saysSkip(words))
    return { kind: "passed", step }
  return typedFact(key, words)
}

/** The same card again under a new id, after a line saying why. */
export function again(
  part: ToolPart,
  reason: RetryReason,
  o: Onboarding,
  newId: () => string
): Part[] {
  const why =
    reason === "quote" ? quoteForm(voiceOf(o)) : retry(reason, voiceOf(o))
  return [text(why), call(part.type, part.input, newId)]
}

/** The names the assistant may take when the owner leaves it to them. */
const NAMES = ["Ava", "Sam", "Max", "Mia", "Leo", "Isla"]

/**
 * The facts the assistant picks for a card the owner left to it ("you
 * pick"), and what it says it picked, or null when the card is not the
 * assistant's to answer: what the business does, its contact details and
 * whether to build are always the owner's.
 */
export function pickFor(part: ToolPart, o: Onboarding): Answer | null {
  const step = stepOf(part)
  const name = NAMES[hash(`${o.orgId}|name`) % NAMES.length] as string
  const palette = firstPalettes(o.orgId)[0] as PaletteId
  const font = FONTS[0]?.id
  // Each pick, and how the assistant names it to the owner.
  const picks: Partial<Record<StepId, [FactValue, string][]>> = {
    assistant: [
      [{ key: "assistant.name", value: { name } }, `the name ${name}`],
      [{ key: "assistant.pronouns", value: { id: "they_them" } }, "they/them"],
      [{ key: "assistant.tone", value: { id: "friendly" } }, "a friendly tone"],
    ],
    template: [
      [
        { key: "site.template", value: { id: "classic" } },
        `the ${label(TEMPLATES, "classic")} layout`,
      ],
    ],
    palette: [
      [
        { key: "site.palette", value: { id: palette } },
        `the ${label(PALETTES, palette)} colours`,
      ],
    ],
    font: font
      ? [
          [
            { key: "site.font", value: { id: font } },
            `${label(FONTS, font)} lettering`,
          ],
        ]
      : [],
    pages: [
      [
        {
          key: "site.pages",
          value: {
            ids: PAGES.map((p) => p.id).filter((p) =>
              DEFAULT_PAGES.includes(p)
            ),
          },
        },
        "the usual pages",
      ],
    ],
  }
  // Only what the owner has not said: a name they typed stays theirs.
  const left = ((step && picks[step]) || []).filter(([f]) => !has(o, f.key))
  if (left.length === 0) return null
  const named = left.map(([, said]) => said)
  return {
    kind: "facts",
    facts: left.map(([f]) => f),
    chose:
      named.length > 1
        ? `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`
        : (named[0] as string),
  }
}

/**
 * What a confident Jev decision on a typed reply means for its card: the
 * option it named, or the assistant's pick when the owner left it to them.
 * Null when code cannot answer it, so the planner reads the words.
 */
export function decided(
  part: ToolPart,
  decision: JevDecision,
  o: Onboarding
): Answer | null {
  if (decision.kind === "defer") return pickFor(part, o)
  const input = AskChoiceInput.safeParse(part.input)
  return part.type === "tool-ask_choice" && input.success
    ? chosen(input.data, [decision.option], null)
    : null
}

/** The next step's parts, after a line saying what the assistant picked, when it picked. */
export function withChoice(
  answer: Answer | undefined,
  o: Onboarding,
  step: Part[]
): Part[] {
  if (answer?.kind !== "facts" || !answer.chose) return step
  const line = chose(voiceOf(o), answer.chose)
  const [lead, ...rest] = step
  return lead?.type === "text"
    ? [text(`${line}\n\n${lead.text}`), ...rest]
    : [text(line), ...step]
}

/** One card of the conversation, as `readScript` reads it. */
export type ScriptRow = {
  type: string
  state: string
  step: string | null
  answer: string | null
  choice: string | null
  /** The owner's typed message that overtook this card, when one did. */
  reply: string | null
}

/**
 * The conversation's progress from its cards. A card talked over by a
 * typed message is read the way the typed turn read it, so a typed skip or
 * a typed answer to the builder question counts as the card would have.
 */
export function progressOf(rows: readonly ScriptRow[]): Progress {
  const passed = new Set<string>()
  const closed = new Set<string>()
  let offered = false
  let builder: boolean | null = null
  for (const row of rows) {
    if (row.type === "tool-request_change") {
      if (row.state === "output-available" || row.state === "output-denied") {
        offered = true
      }
      continue
    }
    const step =
      row.type === "tool-ask_upload"
        ? "upload"
        : row.type === "tool-review_quote_form"
          ? "quote_form"
          : row.step
    if (!step) continue
    // Rows come in order, so each step ends as its latest card left it.
    if (
      row.state === "input-available" ||
      (step === "quote_form" && row.answer === "changes")
    ) {
      closed.delete(step)
    } else {
      closed.add(step)
    }
    if (row.state === "output-available") {
      if (row.answer === "skipped" || row.answer === "uploaded")
        passed.add(step)
      if (step === "manual_builder" && row.answer === "chosen") {
        builder = row.choice === "yes"
      }
    } else if (row.state === "output-error" && row.reply !== null) {
      if (step === "manual_builder") builder = yesNo(row.reply) ?? builder
      if (
        (step === "upload" || SKIPPABLE.includes(step as FactValueKey)) &&
        saysSkip(row.reply)
      ) {
        passed.add(step)
      }
    }
  }
  return { passed: [...passed], closed: [...closed], offered, builder }
}
