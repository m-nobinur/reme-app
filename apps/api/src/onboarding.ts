import {
  AskChoiceInput,
  AskChoiceOutput,
  AskFactInput,
  AskFactOutput,
  AskUploadInput,
  AskUploadOutput,
  type ChoiceStep,
  FactValue,
  type FactValueKey,
  FIXED_PAGES,
  FONTS,
  INDUSTRIES,
  PAGES,
  PALETTES,
  PRONOUNS,
  type RequestChangeOutput,
  TEMPLATES,
  type TemplateId,
  TONES,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES,
  UPLOAD_TYPES,
} from "@workspace/contracts"
import type { Part, ToolPart } from "./chat.ts"
import { industryOf } from "./industry.ts"
import {
  manualEnd,
  notStarted,
  opener,
  photos,
  question,
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

/** A step is its fact's key for an `ask_fact`, its `ChoiceStep` for an `ask_choice`. */
export type StepId =
  | "business.name"
  | "business.offerings"
  | "business.audience"
  | "business.overview"
  | "service_area.text"
  | "business.phone"
  | "business.email"
  | "business.tagline"
  | "assistant.name"
  | "owner.preferred_name"
  | ChoiceStep
  | "upload"
  | "build"

/** The first build's goal: the owner's details are in the facts. */
export const ONBOARDING_GOAL = "Build my website from the details I gave you."

/** The facts an owner may skip; every other one the site or the assistant needs. */
export const SKIPPABLE: readonly FactValueKey[] = ["business.tagline"]

export type Held = { key: string; value: unknown }

/** What the conversation's cards say, read by `readScript`. */
export type Progress = {
  /** Steps closed without a fact: a skip, the photos, the builder answer. */
  passed: readonly string[]
  /** Whether a build was started or offered and answered in this conversation. */
  offered: boolean
  /** The answer to "use the builder yourself?", once given. */
  builder: boolean | null
}

export type Onboarding = Progress & {
  /** Picks each line's wording, so a reload reads the same words. */
  orgId: string
  facts: readonly Held[]
  /** `orgs.name`, for when the business name is not a fact. */
  orgName: string
  /** The session's name for the owner, or "". */
  ownerName: string
}

/** Whether the script has finished: the build is under way or the owner went their own way. */
export const ended = (p: Progress) => p.offered || p.builder !== null

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

const has = (o: Onboarding, key: FactValueKey) =>
  o.facts.some((f) => f.key === key)
const mode = (o: Onboarding) => factValue(o.facts, "site.build_mode")?.mode

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

/** The pages ticked when the card opens. */
const DEFAULT_PAGES = ["home", "services", "about", "contact", "quote"]

/** Each card's options, from the contracts' lists, so an answer is checked against the same ids. */
const CHOICES: Record<ChoiceStep, () => Omit<AskChoiceInput, "step">> = {
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
  palette: () => ({
    options: PALETTES.map((p) => ({
      id: p.id,
      label: p.label,
      hint: p.hint ?? null,
      visual: { kind: "swatches" as const, colors: p.swatches.slice(0, 4) },
    })),
    multiple: false,
    preselected: [],
    other: other("Describe your colours, or name your brand colour"),
    skippable: false,
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

const call = (type: ToolPart["type"], input: unknown, newId: () => string) =>
  ({ type, toolCallId: newId(), state: "input-available", input }) as ToolPart

const text = (words: string): Part => ({
  type: "text",
  text: words,
  state: "done",
})

const factCard = (o: Onboarding, key: FactValueKey, newId: () => string) => {
  const prefill =
    key === "business.name"
      ? { key, value: { name: o.orgName } }
      : key === "owner.preferred_name"
        ? { key, value: { name: o.ownerName } }
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

const choiceCard = (step: ChoiceStep, newId: () => string) =>
  call(
    "tool-ask_choice",
    AskChoiceInput.parse({ step, ...CHOICES[step]() }),
    newId
  )

const uploadCard = (newId: () => string) =>
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

const askFact = (key: Extract<StepId, FactValueKey>): Step => ({
  id: key,
  done: (o) => has(o, key) || o.passed.includes(key),
  ask: (o, newId) => [text(question(key, voiceOf(o))), factCard(o, key, newId)],
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
    choiceCard(step, newId),
  ],
})

const building = (o: Onboarding) => mode(o) === "assistant"

/**
 * The script, in order. Phase 1 the business, phase 2 the assistant, phase
 * 3 the website, phase 4 photos, phase 5 the build. "Skip" on the build
 * question takes the manual branch instead of phases 3 to 5.
 *
 * The photo step is the one step asked even when its fact exists, so the
 * build only ever follows a turn that wrote no fact: the orchestrator
 * snapshots facts over its own connection, and cannot see this turn's
 * uncommitted writes.
 */
export const STEPS: readonly Step[] = [
  askFact("business.name"),
  askChoice("industry", "business.industry"),
  askFact("business.offerings"),
  askFact("business.audience"),
  askFact("business.overview"),
  askFact("service_area.text"),
  askFact("business.phone"),
  askFact("business.email"),
  askFact("business.tagline"),
  askFact("assistant.name"),
  askChoice("pronouns", "assistant.pronouns"),
  askChoice("tone", "assistant.tone"),
  askFact("owner.preferred_name"),
  askChoice("build_for_me", "site.build_mode"),
  {
    id: "manual_builder",
    done: (o) => mode(o) !== "manual" || o.builder !== null,
    ask: (o, newId) => [
      text(question("manual_builder", voiceOf(o))),
      choiceCard("manual_builder", newId),
    ],
  },
  askChoice("template", "site.template", building),
  askChoice("palette", "site.palette", building),
  askChoice("font", "site.font", building),
  askChoice("pages", "site.pages", building),
  {
    id: "upload",
    done: (o) => !building(o) || o.passed.includes("upload"),
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

/** The parts of the next step, or the manual branch's closing line once nothing is left. */
export function onboardingStep(o: Onboarding, newId: () => string): Part[] {
  const step = STEPS.find((each) => !each.done(o))
  if (step) return step.ask(o, newId)
  return [text(manualEnd(voiceOf(o), o.builder === true))]
}

/** The first row a new org sees: the opener, then the first question. */
export function opening(o: Onboarding, newId: () => string): Part[] {
  const [lead, ...rest] = onboardingStep(o, newId)
  return lead?.type === "text"
    ? [text(`${opener(voiceOf(o))}\n\n${lead.text}`), ...rest]
    : [text(opener(voiceOf(o))), ...(lead ? [lead] : []), ...rest]
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
  output: RequestChangeOutput
): Part[] {
  const v = voiceOf(o)
  return [
    { ...pending, state: "output-available", output },
    { type: "step-start" },
    text(
      output.outcome === "started"
        ? started(v, has(o, "media.uploads"))
        : notStarted(v)
    ),
  ]
}

/** What an answer to a step means for the script. */
export type Answer =
  | { kind: "facts"; facts: FactValue[] }
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
      builder: answer.builder ?? o.builder,
    }
  }
  return o
}

/** The step a card asks, from its input. */
export function stepOf(part: ToolPart): StepId | null {
  if (part.type === "tool-ask_upload") return "upload"
  const input = part.input as { key?: StepId; step?: StepId } | null
  if (part.type === "tool-ask_fact") return input?.key ?? null
  if (part.type === "tool-ask_choice") return input?.step ?? null
  return null
}

const CARDS: readonly ToolPart["type"][] = [
  "tool-ask_fact",
  "tool-ask_choice",
  "tool-ask_upload",
]
export const isCard = (part: { type: string }) =>
  CARDS.includes(part.type as ToolPart["type"])

/** Each card's output schema, so a stored answer and a retry compare alike. */
export const OUTPUTS = {
  "tool-ask_fact": AskFactOutput,
  "tool-ask_choice": AskChoiceOutput,
  "tool-ask_upload": AskUploadOutput,
} as const

// ponytail: a keyword table, not a classifier. Anything it misses keeps the
// owner's words in `custom`, which the Developer reads.
const LOOKS: [RegExp, TemplateId][] = [
  [/bold|dark|strong|contrast|punchy|striking/i, "bold"],
  [/modern|minimal|light|simple|airy|photo|image|clean/i, "modern"],
]
const closestTemplate = (words: string): TemplateId =>
  LOOKS.find(([pattern]) => pattern.test(words))?.[1] ?? "classic"

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
        category: id ?? industryOf(words ?? ""),
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
      return fact(
        "site.palette",
        words === null ? { id } : { id: "custom", ...custom }
      )
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
  "business.tagline": "tagline",
  "business.audience": "text",
  "business.overview": "text",
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

/**
 * What a typed reply means for the card it overtook. Text asks take the
 * words as the value; choice cards match an option or take the owner's own
 * words when the card has an Other; the photo card takes a skip. Anything
 * else asks again, with a line that says what was missing.
 */
export function typedAnswer(part: ToolPart, words: string): Answer {
  const step = stepOf(part)
  if (!step) return { kind: "retry", reason: "unclear" }
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
  return [text(retry(reason, voiceOf(o))), call(part.type, part.input, newId)]
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
  let offered = false
  let builder: boolean | null = null
  for (const row of rows) {
    if (row.type === "tool-request_change") {
      if (row.state === "output-available" || row.state === "output-denied") {
        offered = true
      }
      continue
    }
    const step = row.type === "tool-ask_upload" ? "upload" : row.step
    if (!step) continue
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
  return { passed: [...passed], offered, builder }
}
