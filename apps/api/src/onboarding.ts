import {
  AskChoiceInput,
  AskChoiceOutput,
  AskDesignInput,
  AskDesignOutput,
  AskDetailsInput,
  AskDetailsOutput,
  AskFactInput,
  AskFactOutput,
  AskOpenInput,
  AskOpenOutput,
  AskUploadOutput,
  type ChoiceStep,
  DETAILS_KEYS,
  type DetailsStep,
  FactValue,
  type FactValueKey,
  FIXED_PAGES,
  FONT_PAIRS,
  FONTS,
  INDUSTRIES,
  ONBOARDING_GOAL,
  PAGES,
  PALETTES,
  type PaletteFromImage,
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
import DIRECTIONS from "@workspace/starter-site/directions.json"
import type { Part, ToolPart } from "./chat.ts"
import type { JevDecision } from "./jev.ts"
import {
  chose,
  firstName,
  hash,
  manualEnd,
  notStarted,
  opener,
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
  | ChoiceStep
  | DetailsStep
  | "design"
  | "upload"
  | "quote_form"
  | "build"

export { ONBOARDING_GOAL }

/**
 * The facts an owner may skip; every other one the site or the assistant
 * needs. The slogan and how a job runs are never asked: the builder drafts
 * them.
 */
const SKIPPABLE: readonly FactValueKey[] = [
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
  /** The answer to "use the builder yourself?", in conversations that asked it. */
  builder: boolean | null
  /** The owner skipped the website question, on its card or in words. */
  siteSkipped?: boolean
  /**
   * Steps whose latest card is no longer waiting: answered, skipped, or
   * talked over by a typed message and not asked again. A card talked over
   * is asked again whenever the typed reply did not settle it, by the script
   * (`again`) or by the planner (`unanswered`), so a talked-over card that
   * stays closed was settled. A quote form the owner asked to change is not
   * closed: a new proposal follows it.
   */
  closed: readonly string[]
  /**
   * Whether this conversation asked one of the four cards the design tray
   * replaced (template, palette, font, pages): it finishes on them.
   */
  oldDesign?: boolean
}

export type Onboarding = Progress & {
  /** Picks each line's wording, so a reload reads the same words. */
  orgId: string
  facts: readonly Held[]
  /** `orgs.name`, for when the business name is not a fact. */
  orgName: string
  /** The session's name for the owner, or "". */
  ownerName: string
  /** The session's email: the contact card's starting email. */
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
  /** The business's services as a short phrase, such as "your wedding cars". */
  services_phrase: string
  /** Up to three names that suit this business's assistant, offered on its card. */
  assistant_names?: string[]
}

/**
 * Whether the script has finished: the build is under way, or the owner
 * skipped the website. The builder answer is for conversations that asked it
 * before that question was dropped.
 */
export const ended = (p: Progress) =>
  p.offered ||
  p.siteSkipped === true ||
  p.builder !== null ||
  p.closed.includes("manual_builder")

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
  const direction = factValue(o.facts, "site.direction")
  return {
    org: o.orgId,
    business: factValue(o.facts, "business.name")?.name ?? o.orgName,
    owner:
      factValue(o.facts, "owner.preferred_name")?.name ??
      firstName(o.ownerName),
    assistant: factValue(o.facts, "assistant.name")?.name ?? "",
    pronouns: factValue(o.facts, "assistant.pronouns")?.id ?? "they_them",
    tone: factValue(o.facts, "assistant.tone")?.id ?? "friendly",
    industry: factValue(o.facts, "business.industry") ?? null,
    offering: factValue(o.facts, "business.offerings")?.items[0] ?? null,
    template: template?.custom ? null : label(TEMPLATES, template?.id),
    palette: label(PALETTES, palette?.id),
    direction: label(DIRECTIONS, direction?.id),
    ownLook:
      direction?.custom ?? factValue(o.facts, "site.font")?.custom ?? null,
    ownColour: palette?.brand ?? palette?.custom ?? null,
    services: o.prepared?.services_phrase ?? null,
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
  ["sunset", "mocha", "terracotta"],
  ["cardinal", "berry", "burgundy"],
  ["midnight", "damson", "ultra_violet"],
  ["graphite", "onyx", "pebble", "counsel", "after_dark", "ember"],
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

/** The usual pages, plus areas and reviews when the owner's answers hold them. */
const suggestedPages = (facts: Parameters<typeof factValue>[0]) => [
  ...DEFAULT_PAGES,
  ...(factValue(facts, "service_area.text") ? ["service_area"] : []),
  ...(/\breviews?\b|\brating\b|\btestimonials?\b/i.test(
    JSON.stringify(factValue(facts, "business.proof") ?? "")
  )
    ? ["testimonials"]
    : []),
]

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
    key === "business.name" ? { key, value: { name: o.orgName } } : null
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
  // Names written for this business, when the background call has them.
  const ideas = step === "assistant" ? o.prepared?.assistant_names : undefined
  return call(
    "tool-ask_details",
    AskDetailsInput.parse({
      step,
      prefill,
      skippable: false,
      ...(ideas?.length ? { ideas } : {}),
    }),
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

// --- The design tray -------------------------------------------------------

/** The steps of the four cards the tray replaced. */
const OLD_DESIGN: readonly string[] = ["template", "palette", "font", "pages"]

/**
 * Whether this onboarding finishes on the four cards the tray replaced: its
 * conversation asked one, or the org holds a template from before the tray.
 */
export const oldDesign = (o: Onboarding) =>
  o.oldDesign === true || has(o, "site.template")

/** Each tray question's id, and the fact its answer becomes. */
const DESIGN = {
  palette: "site.palette",
  lettering: "site.font",
  arrangement: "site.direction",
  pages: "site.pages",
} as const satisfies Record<string, FactValueKey>

/** The tray's pages of their own, answered with what they settled, never a pick. */
const PAGES_OF_THEIR_OWN: readonly string[] = ["logo", "photos"]

/** The pages the tray's last question offers: every page but the ones always built. */
const PAGE_PICKS = PAGES.filter(
  (p) => !(FIXED_PAGES as readonly string[]).includes(p.id)
)

/** Words that, before a page's name in its clause, mean the owner does not want it. */
const NEGATIONS = new Set([
  "no",
  "not",
  "without",
  "dont",
  "never",
  "skip",
  "nor",
])

/**
 * The pages a typed answer names, by label or id, so "Gallery and FAQ" is
 * honoured as a tick would be and "no gallery" or "don't need a FAQ" is not:
 * a name counts unless a negation comes before it in its clause, the words
 * between commas, "and", "but" or "plus". shortcut: no grammar past that, so
 * "don't forget the gallery" drops it; hand the words to a model if owners
 * write prose here.
 */
export const pagesNamed = (words: string) => {
  const clauses = words.split(/[,.;:!?\n]|\b(?:and|but|plus)\b/i).map(plainly)
  return PAGES.filter((p) =>
    [p.label, p.id.replaceAll("_", " ")].some((name) => {
      const named = new RegExp(`(?:^| )${plainly(name)}s?(?= |$)`)
      return clauses.some((clause) => {
        const at = clause.search(named)
        return (
          at >= 0 &&
          !clause
            .slice(0, at)
            .split(" ")
            .some((word) => NEGATIONS.has(word))
        )
      })
    })
  ).map((p) => p.id)
}

/** The directions whose industries list the business's; every direction when none does. */
function directionsFor(o: Onboarding) {
  const industry = factValue(o.facts, "business.industry")?.category
  const fit = DIRECTIONS.filter((d) =>
    (d.industries as readonly string[]).includes(industry ?? "")
  )
  return fit.length >= 2 ? fit : DIRECTIONS
}

/** The pool in an order seeded by the org and the question: the same org sees the same ones after a reload. */
const seeded = <T>(
  org: string,
  kind: string,
  pool: readonly T[],
  id: (t: T) => string
) =>
  [...pool].sort(
    (a, b) =>
      hash(`${org}|design|${kind}|${id(a)}`) -
      hash(`${org}|design|${kind}|${id(b)}`)
  )

const SHOWN = 4

/** What a tray question shows: the first four of the seeded pool, never two that look alike. */
function firstOf<T>(
  o: Onboarding,
  kind: string,
  pool: readonly T[],
  id: (t: T) => string,
  alike: (t: T) => string
): T[] {
  const kept: T[] = []
  for (const each of seeded(o.orgId, kind, pool, id)) {
    if (kept.length < SHOWN && !kept.some((k) => alike(k) === alike(each))) {
      kept.push(each)
    }
  }
  return kept
}

/** The org's stored images, from `media.uploads`. */
const uploadsOf = (facts: readonly Held[]) =>
  factValue(facts, "media.uploads")?.items ?? []

/** The logo the org holds, kept by the logo page. */
export const logoOf = (facts: readonly Held[]) =>
  uploadsOf(facts).find((a) => a.use === "logo")

/** A logo or photos page's card: its two ways, so every question reads alike. */
const pageCard = (upload: string, create: string): AskChoiceInput => ({
  // The card's shape needs a step; these pages stand in for no old card.
  step: "template",
  options: plain([
    { id: "upload", label: upload },
    { id: "create", label: create },
  ]),
  multiple: false,
  preselected: [],
  other: null,
  skippable: false,
})

/** A logo or photos page's drop zone. */
const dropZone = (files: number) => ({
  accept: [...UPLOAD_TYPES],
  max_files: files,
  max_bytes: UPLOAD_MAX_BYTES,
  skippable: false,
})

/**
 * The design tray: six questions, with options drawn from the directions
 * that list the business's industry and seeded by org, so two cleaning
 * businesses do not see the same four. A question the org already answered
 * opens ticked, so a tray asked again starts where the owner left off; the
 * logo and photos pages open with what the org holds.
 */
export function designCard(o: Onboarding, newId: () => string): ToolPart {
  const directions = directionsFor(o)
  const suited = [
    ...new Set(directions.flatMap((d) => d.palettes)),
  ] as PaletteId[]
  const palette = factValue(o.facts, "site.palette")
  const shown = firstOf(
    o,
    "palette",
    suited,
    (id) => id,
    (id) => String(family(id))
  )
  // A held palette the four leave out takes the last place, so it shows ticked.
  const heldPalette = PaletteId.safeParse(palette?.id)
  if (heldPalette.success && !shown.includes(heldPalette.data)) {
    shown.splice(SHOWN - 1, 1, heldPalette.data)
  }
  // Every palette: the four shown, then the rest that suit the business.
  const palettes = [...new Set([...shown, ...suited, ...PaletteId.options])]
  const pairs = firstOf(
    o,
    "lettering",
    FONT_PAIRS.filter((pair) => directions.some((d) => d.fonts === pair.id)),
    (pair) => pair.id,
    // Two pairs with the same title font read as one choice offered twice.
    (pair) => pair.display.family
  )
  const layouts = firstOf(
    o,
    "arrangement",
    directions,
    (d) => d.id,
    (d) => `${d.hero}|${d.services}`
  )
  const ticked = (
    id: string | undefined,
    options: readonly { id: string }[]
  ) => (id !== undefined && options.some((each) => each.id === id) ? [id] : [])
  // The card's `step` names the old card the question stands in for.
  const card = (
    step: ChoiceStep,
    options: Option[],
    held: string | undefined,
    placeholder: string,
    words?: string
  ): AskChoiceInput => ({
    step,
    options,
    multiple: false,
    preselected: ticked(held, options),
    other: { label: "Write your own…", placeholder },
    skippable: true,
    ...(words ? { own: words } : {}),
  })
  const paletteOptions = palettes.map((id): Option => {
    const preset = PALETTES.find((p) => p.id === id)
    return {
      id,
      label: preset?.label ?? id,
      hint: null,
      visual: { kind: "swatches", colors: preset?.swatches ?? [] },
    }
  })
  const pairOptions = pairs.map(
    (pair): Option => ({
      id: pair.id,
      label: pair.label,
      hint: null,
      visual: {
        kind: "font_pair",
        display: pair.display.family,
        body: pair.body.family,
      },
    })
  )
  const layoutOptions = layouts.map(
    (d): Option => ({
      id: d.id,
      label: d.label,
      hint: null,
      visual: { kind: "layout", hero: d.hero, services: d.services },
    })
  )
  const pageOptions = PAGE_PICKS.map(
    (page): Option => ({
      id: page.id,
      label: page.label,
      hint: page.hint,
      visual: null,
    })
  )
  const font = factValue(o.facts, "site.font")
  const direction = factValue(o.facts, "site.direction")
  const pagesHeld = factValue(o.facts, "site.pages")
  const logo = logoOf(o.facts)
  // The photos the review placed; one it found no use for is not held.
  const photos = uploadsOf(o.facts).filter(
    (a) => a.use !== undefined && a.use !== "logo"
  )
  return call(
    "tool-ask_design",
    AskDesignInput.parse({
      questions: [
        {
          id: "logo",
          question: "Do you have a logo?",
          visual: "logo",
          card: pageCard("Yes, I have my logo", "No, create one for me"),
          upload: dropZone(1),
          ...(logo ? { held: [logo] } : {}),
        },
        {
          id: "palette",
          question: "Which colour palette feels right for your business?",
          visual: "palette",
          card: {
            ...card(
              "palette",
              paletteOptions,
              palette?.id,
              "A colour code, or describe your colours",
              paletteOwn(o.facts)
            ),
            ...(shown.length >= 3 ? { initial: shown } : {}),
          },
        },
        {
          id: "lettering",
          question: "Which lettering do you prefer?",
          visual: "font_pair",
          card: card(
            "font",
            pairOptions,
            font?.id,
            "Describe the lettering you like",
            font?.id === "custom" ? font.custom : undefined
          ),
        },
        {
          id: "arrangement",
          question: "Which page arrangement do you prefer?",
          visual: "layout",
          card: card(
            "template",
            layoutOptions,
            direction?.id,
            "Describe the layout you have in mind",
            direction?.id === "custom" ? direction.custom : undefined
          ),
        },
        {
          id: "photos",
          question: "Do you have photos of your work?",
          visual: "photos",
          card: pageCard("Upload photos", "Create them for me"),
          upload: dropZone(UPLOAD_MAX_FILES),
          ...(photos.length > 0 ? { held: photos } : {}),
        },
        {
          id: "pages",
          question:
            "Which pages should the site have, besides Home and Request a quote?",
          visual: "text",
          card: {
            ...card(
              "pages",
              pageOptions,
              undefined,
              "Name the pages you want and what goes on them",
              pagesHeld?.custom
            ),
            // Any number of pages: the held pick, else the usual ones ticked,
            // with the areas and reviews pages when the owner already gave them.
            multiple: true,
            preselected: pageOptions
              .map((each) => each.id)
              .filter((page) =>
                (pagesHeld && !pagesHeld.custom
                  ? (pagesHeld.ids as readonly string[])
                  : suggestedPages(o.facts)
                ).includes(page)
              ),
          },
        },
      ],
    }),
    newId
  )
}

/** A reply as compared with a label: lower case, words only. */
const plainly = (words: string) =>
  words
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim()

/**
 * The option a typed reply names whole, by its label, on a tray: code
 * answers that question, as it does for a choice card. Null when no option,
 * or more than one, has that label.
 */
export function trayOption(part: ToolPart, words: string): string | null {
  const tray = AskDesignInput.safeParse(part.input)
  const said = plainly(words)
  const named = tray.success
    ? tray.data.questions
        .filter((q) => !PAGES_OF_THEIR_OWN.includes(q.visual))
        .flatMap((q) => q.card.options)
        .filter((o) => plainly(o.label) === said)
    : []
  return named.length === 1 ? (named[0]?.id ?? null) : null
}

/**
 * Whether the tray is finished: closed, or every answer it asks is held,
 * the logo with them. The photos leave no fact, and with none the builder
 * draws them.
 */
export const designDone = (o: Onboarding) =>
  o.closed.includes("design") ||
  ((Object.values(DESIGN) as FactValueKey[]).every((key) => has(o, key)) &&
    logoOf(o.facts) !== undefined)

/** The palette read from the owner's picture: its primary is the brand colour, its name and stops the notes. */
const picturePalette = ({ name, stops }: PaletteFromImage) => ({
  id: "custom",
  brand: stops.primary,
  custom: `${name}: paper ${stops.paper}, tint ${stops.tint}, primary ${stops.primary}, ink ${stops.ink}`,
})
const PICTURE =
  /^(.+): paper #[0-9a-f]{6}, tint #[0-9a-f]{6}, primary #[0-9a-f]{6}, ink #[0-9a-f]{6}$/

/**
 * A held custom palette as the tray shows it in `own`: one read from a
 * picture by its name, else the owner's words or colour. The tray sends it
 * back unchanged when the owner keeps it.
 */
const paletteOwn = (held: readonly Held[]) => {
  const palette = factValue(held, "site.palette")
  if (palette?.id !== "custom") return undefined
  return palette.custom?.match(PICTURE)?.[1] ?? palette.custom ?? palette.brand
}

/**
 * What the tray's answers mean: the fact each one states, as given. "Write
 * your own" is kept as the owner wrote it, in the fact's `custom` note, and
 * a colour code takes the brand colour path, as does a palette read from a
 * picture. The logo and photos pages state no fact: what they settled is in
 * `media.uploads` already, so their answer must name what it holds. A
 * question skipped states nothing. `settled` is whether the tray is done:
 * Build my site or Skip all, as against an answer sent as the owner leaves
 * its question; it needs a logo, answered or held. Skip all also records
 * that the owner left the look to the builder, unless a layout is already
 * held. Null when an answer does not fit its question.
 */
export function designAnswer(
  input: AskDesignInput,
  output: unknown,
  held: readonly Held[]
): Answer | null {
  const given = AskDesignOutput.safeParse(output)
  if (!given.success) return null
  const { answers, skip_all } = given.data
  const uploads = uploadsOf(held)
  const facts: FactValue[] = []
  const state = (key: FactValueKey, value: unknown) => {
    const fact = FactValue.safeParse({ key, value })
    if (fact.success) facts.push(fact.data)
    return fact.success
  }
  for (const [id, answer] of Object.entries(answers)) {
    const asked = input.questions.find((q) => q.id === id)
    if (!asked) return null
    if (asked.visual === "logo") {
      const logo = "logo" in answer ? answer.logo : null
      if (!uploads.some((u) => u.id === logo?.id && u.use === "logo"))
        return null
      continue
    }
    if (asked.visual === "photos") {
      if (
        !("photos" in answer) ||
        !answer.photos.every((p) => uploads.some((u) => u.id === p.id))
      )
        return null
      continue
    }
    const key = DESIGN[id as keyof typeof DESIGN]
    if (!key || "logo" in answer || "photos" in answer) return null
    if ("palette" in answer) {
      if (key !== "site.palette" || !state(key, picturePalette(answer.palette)))
        return null
      continue
    }
    // The held palette sent back as the tray showed it: kept as held, so a
    // picture's colours survive a reload.
    if (
      key === "site.palette" &&
      "own" in answer &&
      answer.own === paletteOwn(held)
    )
      continue
    if ("skipped" in answer) {
      if (!asked.card.skippable) return null
      continue
    }
    const offered = (option: string) =>
      asked.card.options.some((each) => each.id === option)
    if ("choice" in answer) {
      if (asked.card.multiple || !offered(answer.choice)) return null
    } else if ("choices" in answer) {
      if (!asked.card.multiple || !answer.choices.every(offered)) return null
    } else if (asked.card.other === null) return null
    const choice = "choice" in answer ? answer.choice : null
    const own = "own" in answer ? answer.own : ""
    // The pages ticked, or named in their words. A tray from before pages
    // were ticked one by one offers sets, which name no page: refused.
    const pages =
      "choices" in answer ? answer.choices : choice ? [choice] : pagesNamed(own)
    if (
      key === "site.pages" &&
      !pages.every((page) => PAGES.some((p) => p.id === page))
    )
      return null
    const stated =
      key === "site.palette"
        ? state(key, choice === null ? ownPalette(own) : { id: choice })
        : key === "site.pages"
          ? state(key, {
              ids: PAGES.map((p) => p.id).filter(
                (page) =>
                  (FIXED_PAGES as readonly string[]).includes(page) ||
                  pages.includes(page)
              ),
              ...(own ? { custom: own } : {}),
            })
          : state(
              key,
              choice === null ? { id: "custom", custom: own } : { id: choice }
            )
    if (!stated) return null
  }
  const settled =
    skip_all || input.questions.every((each) => each.id in answers)
  const logoAsked = input.questions.find((q) => q.visual === "logo")
  if (
    settled &&
    logoAsked &&
    !(logoAsked.id in answers) &&
    logoOf(held) === undefined
  )
    return null
  if (
    skip_all &&
    !facts.some((f) => f.key === "site.direction") &&
    !held.some((f) => f.key === "site.direction")
  ) {
    state("site.direction", { id: "builder" })
  }
  return { kind: "design", facts, settled }
}

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

/**
 * Whether `o` holds what a details card is for. The face is offered on the
 * assistant's card but never waited on: with no pick it stays Reme's.
 */
export const detailsDone = (o: Onboarding, step: DetailsStep) =>
  DETAILS_KEYS[step].every((key) => key === "assistant.avatar" || has(o, key))

/** A few related facts on one card, done once every one is held. */
const askDetails = (step: DetailsStep): Step => ({
  id: step,
  done: (o) => detailsDone(o, step),
  ask: (o, newId) => [
    text(question(step, voiceOf(o))),
    detailsCard(step, o, newId),
  ],
})

/** A choice step, done once its fact exists or while `applies` says it is not asked. */
const askChoice = (
  // The builder question is no longer asked; its card stays in old conversations.
  step: Exclude<ChoiceStep, "manual_builder">,
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
 * 3 the website and its quote form, phase 4 the design, logo and photos
 * in one tray, whose answer starts the build. "Skip" on the build question
 * takes the manual branch instead of phases 3 and 4. The opener asks what the business does in words, and the planner
 * reads the answers to the open questions; the script asks the rest with a
 * card, and asks the open ones with a form when the planner cannot run. The
 * industry card comes only when the owner's words did not tell the planner.
 *
 * The build follows the design's answer in the same turn, and the
 * orchestrator snapshots facts over its own connection, so `chat.ts`
 * commits that answer's facts before it starts the build.
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
  askChoice("build_for_me", "site.build_mode"),
  {
    // The build waits for a quote form the owner reviewed or declined. The
    // question is asked in words, answered in the tray, and the planner
    // proposes a form from the answer; with no model, a typed answer gets the
    // script's short form to confirm (`defaultQuoteForm`).
    id: "quote_form",
    done: (o) =>
      !building(o) || has(o, "quote.form") || o.closed.includes("quote_form"),
    ask: (o, newId) => [
      text(question("quote_form", voiceOf(o))),
      call("tool-ask_open", AskOpenInput.parse({ about: "quote.form" }), newId),
    ],
  },
  // An org that reaches the design after the tray shipped is asked in one
  // tray; one that was mid-way through the four cards finishes on them.
  {
    id: "design",
    done: (o) => !building(o) || oldDesign(o) || designDone(o),
    ask: (o, newId) => [
      text(question("design", voiceOf(o))),
      designCard(o, newId),
    ],
  },
  askChoice("template", "site.template", (o) => building(o) && oldDesign(o)),
  askChoice("palette", "site.palette", (o) => building(o) && oldDesign(o)),
  askChoice("font", "site.font", (o) => building(o) && oldDesign(o)),
  askChoice("pages", "site.pages", (o) => building(o) && oldDesign(o)),
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
const defaultQuoteForm = (o: Onboarding, newId: () => string) => [
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

/** The parts of the next step, or the closing line for a skipped website once nothing is left. */
export function onboardingStep(o: Onboarding, newId: () => string): Part[] {
  const step = currentStep(o)
  if (step) return step.ask(o, newId)
  return [text(manualEnd(voiceOf(o)))]
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
        ? (said ??
            started(
              v,
              uploadsOf(o.facts).some((a) => a.use !== "logo")
            ))
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
  /** The design tray's answers; `settled` once it is finished, not just answered so far. */
  | { kind: "design"; facts: FactValue[]; settled: boolean }
  | { kind: "passed"; step: StepId; builder?: boolean }
  | { kind: "retry"; reason: RetryReason }

/** The onboarding with an answer applied, as the next step reads it. */
export function applied(o: Onboarding, answer: Answer): Onboarding {
  if (answer.kind === "facts" || answer.kind === "design") {
    const keys = new Set(answer.facts.map((f) => f.key))
    return {
      ...o,
      facts: [
        ...o.facts.filter((f) => !keys.has(f.key as never)),
        ...answer.facts,
      ],
      closed:
        answer.kind === "design" && answer.settled
          ? [...o.closed, "design"]
          : o.closed,
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
  if (part.type === "tool-ask_design") return "design"
  const input = part.input as { key?: StepId; step?: StepId } | null
  if (part.type === "tool-ask_fact") return input?.key ?? null
  if (part.type === "tool-ask_choice" || part.type === "tool-ask_details") {
    return input?.step ?? null
  }
  return null
}

const CARDS: readonly ToolPart["type"][] = [
  "tool-ask_open",
  "tool-ask_fact",
  "tool-ask_details",
  "tool-ask_choice",
  "tool-ask_design",
  "tool-ask_upload",
  "tool-review_quote_form",
]
export const isCard = (part: { type: string }) =>
  CARDS.includes(part.type as ToolPart["type"])

/** Each card's output schema, so a stored answer and a retry compare alike. */
export const OUTPUTS = {
  "tool-ask_open": AskOpenOutput,
  "tool-ask_fact": AskFactOutput,
  "tool-ask_details": AskDetailsOutput,
  "tool-ask_choice": AskChoiceOutput,
  "tool-ask_design": AskDesignOutput,
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
  uploads: readonly { id: string }[],
  /** The org's facts, for a tray's Skip all, which keeps a layout already held. */
  held: readonly Held[] = []
): Answer | null {
  // The planner's question in words: what the owner wrote is theirs for the
  // planner to read, so it states no fact here. A skip passes an optional
  // fact, and declines any other for the planner to read.
  if (part.type === "tool-ask_open") {
    const answer = AskOpenOutput.safeParse(output)
    if (!answer.success) return null
    const { about } = part.input as AskOpenInput
    return answer.data.answer === "skipped" && SKIPPABLE.includes(about)
      ? { kind: "passed", step: about as StepId }
      : { kind: "facts", facts: [] }
  }
  const step = stepOf(part)
  if (!step) return null
  if (part.type === "tool-ask_design") {
    const input = AskDesignInput.safeParse(part.input)
    return input.success ? designAnswer(input.data, output, held) : null
  }
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
function yesNo(words: string): boolean | null {
  const said = norm(words)
  if (YES.test(said)) return true
  if (NO.test(said)) return false
  return null
}

/** Whether a typed reply passes over a skippable step. */
const saysSkip = (words: string) => SKIP.test(norm(words))

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
  // The tray is answered on the tray; words over it go to the planner.
  if (part.type === "tool-ask_design")
    return { kind: "retry", reason: "unclear" }
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
  // The tray comes back as the org's answers leave it, not as it was first made.
  return [
    text(why),
    part.type === "tool-ask_design"
      ? designCard(o, newId)
      : call(part.type, part.input, newId),
  ]
}

/** The names the assistant may take when the owner leaves it to them. */
const NAMES = ["Ava", "Sam", "Max", "Mia", "Leo", "Isla"]

/**
 * The facts the assistant picks for a card the owner left to it ("you
 * pick"), and what it says it picked, or null when the card is not the
 * assistant's to answer: what the business does, its contact details and
 * whether to build are always the owner's.
 */
function pickFor(part: ToolPart, o: Onboarding): Answer | null {
  const step = stepOf(part)
  const name = NAMES[hash(`${o.orgId}|name`) % NAMES.length] as string
  const palette = firstPalettes(o.orgId)[0] as PaletteId
  const font = FONTS[0]?.id
  // Each pick, and how the assistant names it to the owner.
  const picks: Partial<Record<StepId, [FactValue, string][]>> = {
    assistant: [
      [{ key: "assistant.name", value: { name } }, `the name ${name}`],
      [{ key: "assistant.pronouns", value: { id: "they_them" } }, "they/them"],
      [{ key: "assistant.avatar", value: { id: "reme" } }, "Reme's own look"],
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
  if (part.type === "tool-ask_design") {
    const tray = AskDesignInput.safeParse(part.input)
    const asked =
      tray.success &&
      tray.data.questions.find(
        (q) =>
          !PAGES_OF_THEIR_OWN.includes(q.visual) &&
          q.card.options.some((each) => each.id === decision.option)
      )
    return asked
      ? designAnswer(
          tray.data,
          {
            answers: {
              [asked.id]: asked.card.multiple
                ? { choices: [decision.option] }
                : { choice: decision.option },
            },
            skip_all: false,
          },
          o.facts
        )
      : null
  }
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
  let siteSkipped = false
  let old = false
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
          : row.type === "tool-ask_design"
            ? "design"
            : row.step
    if (!step) continue
    if (row.type === "tool-ask_choice" && OLD_DESIGN.includes(step)) old = true
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
      if (step === "build_for_me" && row.answer === "chosen") {
        siteSkipped = row.choice === "skip"
      }
    } else if (row.state === "output-error" && row.reply !== null) {
      if (step === "manual_builder") builder = yesNo(row.reply) ?? builder
      if (step === "build_for_me") {
        siteSkipped = saysSkip(row.reply) || yesNo(row.reply) === false
      }
      if (
        (step === "upload" || SKIPPABLE.includes(step as FactValueKey)) &&
        saysSkip(row.reply)
      ) {
        passed.add(step)
      }
    }
  }
  return {
    passed: [...passed],
    closed: [...closed],
    offered,
    builder,
    ...(siteSkipped ? { siteSkipped } : {}),
    ...(old ? { oldDesign: true } : {}),
  }
}
