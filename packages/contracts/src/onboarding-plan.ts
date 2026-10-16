import { z } from "zod"
import { ChoiceStep, DetailsStep } from "./chat.ts"
import { QuoteFields } from "./onboarding.ts"
import {
  FactValue,
  type FactValueKey,
  REVIEW_FACT_KEYS,
  type ReviewFactKey,
} from "./owner.ts"
import { Text } from "./text.ts"

/**
 * What the onboarding planner writes each turn: one structured model call
 * that reads the owner's words and decides the turn. Not an HTTP contract and
 * not in the registry; it lives here because it is a boundary (a model's
 * output crosses into the api) and zod lives here. The api checks every
 * field again against the conversation's state before anything is stored.
 */

/**
 * The facts the planner may state from the owner's words. Photos arrive
 * only through `POST /assets`, the quote form only through the owner's
 * confirmation of a proposal, and a review only through `record_review`'s
 * card, so none of them is here.
 */
export const PLAN_FACT_KEYS = FactValue.options
  .map((o) => o.shape.key.value)
  .filter(
    (key) =>
      key !== "media.uploads" &&
      key !== "quote.form" &&
      !(REVIEW_FACT_KEYS as readonly string[]).includes(key)
  ) as Exclude<FactValueKey, "media.uploads" | "quote.form" | ReviewFactKey>[]
export type PlanFactKey = (typeof PLAN_FACT_KEYS)[number]

/**
 * The facts the assistant may choose for the owner when the owner leaves it
 * to them ("you pick the colours"). Contact details and what the business
 * does never are: those are the owner's to say.
 */
export const DEFAULTABLE_KEYS = [
  "business.tagline",
  "assistant.name",
  "assistant.pronouns",
  "assistant.tone",
  "owner.preferred_name",
  "site.template",
  "site.palette",
  "site.font",
  "site.pages",
] as const satisfies readonly PlanFactKey[]

type Values = { [F in FactValue as F["key"]]: F["value"] }

/**
 * Each key's value in the fact's own shape, so a planned fact is a
 * `FactValue` once its key is put back. Every entry is optional: the model
 * writes only what the owner's words gave.
 */
export const PlanFacts = z.strictObject(
  Object.fromEntries(
    FactValue.options
      .filter((o) =>
        (PLAN_FACT_KEYS as readonly string[]).includes(o.shape.key.value)
      )
      .map((o) => [o.shape.key.value, o.shape.value.optional()])
  )
) as unknown as z.ZodType<Partial<Pick<Values, PlanFactKey>>>

/**
 * The turn's next move. The model names what to ask; the api builds every
 * card from the contracts' lists, so an option id, a limit or a visual is
 * never the model's.
 */
export const PlanNext = z.discriminatedUnion("kind", [
  /** A question the owner answers in words, naming the fact it is after. */
  z.strictObject({
    kind: z.literal("ask_open"),
    about: z.enum([...PLAN_FACT_KEYS, "quote.form"] as unknown as [
      PlanFactKey | "quote.form",
      ...(PlanFactKey | "quote.form")[],
    ]),
  }),
  /**
   * A closed list from the contracts; `preselected` ticks some of its ids,
   * and for the palettes `initial` names the three or four shown first, or
   * is empty for the card's own seeded four.
   */
  z.strictObject({
    kind: z.literal("ask_choice"),
    step: ChoiceStep,
    preselected: z.array(Text(40)).max(16),
    initial: z.array(Text(40)).max(4),
  }),
  /**
   * The design tray: palette, lettering, page arrangement and pages as four
   * questions, replacing the template, palette, font and pages cards.
   */
  z.strictObject({ kind: z.literal("ask_design") }),
  /** A form for one fact, such as a phone number. */
  z.strictObject({
    kind: z.literal("ask_fact"),
    key: z.enum(PLAN_FACT_KEYS as [PlanFactKey, ...PlanFactKey[]]),
  }),
  /** One card for a few related facts: phone and email, or the assistant's name, pronouns and tone. */
  z.strictObject({ kind: z.literal("ask_details"), step: DetailsStep }),
  /** The photo drop zone. */
  z.strictObject({ kind: z.literal("ask_upload") }),
  /** The questions the site's quote request form should ask, for the owner to confirm. */
  z.strictObject({
    kind: z.literal("review_quote_form"),
    fields: QuoteFields,
    note: Text(300).nullable(),
  }),
  /** Start the first build; the api checks it is due. */
  z.strictObject({ kind: z.literal("start_build") }),
  /** A reply with no new question, such as the answer to a side question. */
  z.strictObject({ kind: z.literal("answer_only") }),
])

/**
 * How a typed message relates to the card it overtook: it answered it, the
 * owner declined it, or it was about something else, in which case the card
 * is shown again. Null when no card was waiting or the owner used the card.
 */
export const PendingCard = z.enum(["answered", "declined", "unanswered"])

export const OnboardingPlan = z.strictObject({
  facts: PlanFacts,
  /** Keys in `facts` the assistant chose because the owner left it to them. */
  chosen_for_owner: z
    .array(z.enum(DEFAULTABLE_KEYS))
    .max(DEFAULTABLE_KEYS.length),
  pending_card: PendingCard.nullable(),
  /** The message to the owner. The api checks its length and content. */
  say: z.string().min(1),
  next: PlanNext,
})

export type OnboardingPlan = z.infer<typeof OnboardingPlan>
export type PlanNext = z.infer<typeof PlanNext>
export type PendingCard = z.infer<typeof PendingCard>
