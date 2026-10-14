import { z } from "zod"
import { Uuid } from "./common.ts"
import { ConversationMessage } from "./conversation.ts"
import { Blueprint, SectionVariant } from "./design.ts"
import { ToolCallId } from "./ids.ts"
import {
  Asset,
  HexColour,
  QuoteFields,
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES,
  UPLOAD_TYPES,
} from "./onboarding.ts"
import { ANSWER_TEXT_MAX, BuildSummary, FactValue, GOAL_MAX } from "./owner.ts"
import { Refused } from "./refused.ts"
import { Text } from "./text.ts"

const MessageId = ConversationMessage.shape.id
/** The AI SDK or the api makes these. Named apart from `MessageId` so tightening one never moves the other. */
const ApprovalId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

/**
 * The most an onboarding turn waits on its planner, every attempt included,
 * before the script answers it instead (`apps/api`'s `PLANNER.totalMs`).
 */
export const PLANNER_TURN_MS = 30_000

/**
 * How long `POST /chat` may take to start answering, for the web's proxy to
 * wait: the planner's turn, then the script's step and a build start (the
 * orchestrator bridge's 10 s), and 5 s for the database on either side.
 * Every other call keeps the web's ordinary bound.
 */
export const CHAT_TURN_MS = PLANNER_TURN_MS + 10_000 + 5_000

/**
 * The error text of a call a typed message overtook: assistant-ui's own
 * words, stored by the api and read by the web, so a reload matches.
 */
export const TOOL_CALL_CANCELLED =
  "User cancelled tool call by sending a new message."

/**
 * How a Chief of Staff tool's error text begins (ADR-034). `TOOL_FAILED`
 * means the call did nothing: the builder answered in a shape the api does
 * not accept. `TOOL_UNKNOWN` means nobody can vouch for the outcome: it may
 * have happened. The api builds every error line from these, and the web
 * reads them back with `toolErrorKind`.
 */
export const TOOL_FAILED = "tool_failed"
export const TOOL_UNKNOWN = "unknown_outcome"

/**
 * What a tool's error text says happened. Only a `TOOL_FAILED` line, which
 * names its code as `tool_failed (<code>)`, is `failed`. Every other text is
 * `unknown`, a future or unrecognised one included, and so is an older
 * stored `tool_failed:` line, whose outcome was never known: telling an owner
 * that something did not happen when it may have invites a duplicate.
 * `TOOL_CALL_CANCELLED` is neither, so callers check it first.
 */
export function toolErrorKind(errorText: string): "failed" | "unknown" {
  return errorText.startsWith(`${TOOL_FAILED} (`) ? "failed" : "unknown"
}

/** Each `FactValue` option as its `ask_fact` input, so `prefill` keeps its key's type. */
type Asks<T extends readonly unknown[]> = {
  [I in keyof T]: T[I] extends z.ZodObject<{
    key: infer K extends z.ZodType
    value: infer V extends z.ZodType
  }>
    ? z.ZodObject<
        { key: K; skippable: z.ZodBoolean; prefill: z.ZodNullable<V> },
        z.core.$strict
      >
    : never
}

/**
 * `ask_fact`'s input: which fact to ask for, whether the owner may skip it,
 * and a value to start from. `prefill` has the key's own shape. The copy and
 * the input kind are the web's, by key, so neither is on the wire.
 */
export const AskFactInput = z.discriminatedUnion(
  "key",
  FactValue.options.map((o) =>
    z.strictObject({
      key: o.shape.key,
      skippable: z.boolean(),
      prefill: o.shape.value.nullable(),
    })
  ) as unknown as Asks<typeof FactValue.options>
)

/**
 * `ask_fact`'s output. The api refuses a fact for another key than the
 * call's, and a skip of a call that is not skippable.
 */
export const AskFactOutput = z.discriminatedUnion("answer", [
  z.strictObject({ answer: z.literal("stated"), fact: FactValue }),
  z.strictObject({ answer: z.literal("skipped") }),
])

/** The step of onboarding an `ask_choice` card is for. The api reads the answer by it. */
export const ChoiceStep = z.enum([
  "industry",
  "pronouns",
  "tone",
  "build_for_me",
  "manual_builder",
  "template",
  "palette",
  "font",
  "pages",
])

/** What a choice looks like beside its label: colour chips, a type sample or a page sketch. */
const ChoiceVisual = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("swatches"),
    colors: z.array(HexColour).min(1).max(4),
  }),
  z.strictObject({ kind: z.literal("font"), family: Text(80) }),
  z.strictObject({ kind: z.literal("template"), id: Text(20) }),
  z.strictObject({
    kind: z.literal("font_pair"),
    display: Text(80),
    body: Text(80),
  }),
  z.strictObject({
    kind: z.literal("layout"),
    hero: SectionVariant,
    services: SectionVariant,
  }),
])

/**
 * `ask_choice`'s input: a question answered from a short list. `other` is
 * the owner's way out of the list, a label and a hint for a text box, or
 * null when the list is closed. The question itself is the text part before
 * the card, written by the api.
 */
export const AskChoiceInput = z
  .strictObject({
    step: ChoiceStep,
    options: z
      .array(
        z.strictObject({
          id: Text(40),
          label: Text(80),
          hint: Text(120).nullable(),
          visual: ChoiceVisual.nullable(),
        })
      )
      .min(2)
      .max(24),
    /** Whether more than one may be picked. */
    multiple: z.boolean(),
    /** Options ticked when the card opens. */
    preselected: z.array(Text(40)).max(16),
    other: z
      .strictObject({ label: Text(60), placeholder: Text(120) })
      .nullable(),
    skippable: z.boolean(),
    /**
     * The owner's own words, held from an earlier answer to this card: the
     * design tray reads it as that question already answered, so a reload
     * resumes after it rather than asking again.
     */
    own: Text(200).optional(),
    /**
     * The options the card shows first, when the list is long. The owner
     * reaches the rest with a Show others button, as many at a time.
     * Absent, the card shows every option.
     */
    initial: z.array(Text(40)).min(3).max(4).optional(),
    /** Whether Other offers a colour picker, whose answer is a `#rrggbb` in `other`. */
    color: z.boolean().optional(),
  })
  .refine(
    (card) =>
      (card.initial ?? []).every((id) =>
        card.options.some((option) => option.id === id)
      ),
    { path: ["initial"], message: "initial names only offered ids" }
  )
  .refine((card) => !card.color || card.other !== null, {
    path: ["color"],
    message: "a colour picker needs Other",
  })

/**
 * `ask_choice`'s output. The api refuses an id that is not in the call's
 * options, a step other than the call's, and an answer with neither an id
 * nor the owner's own words.
 */
export const AskChoiceOutput = z.discriminatedUnion("answer", [
  z.strictObject({
    answer: z.literal("chosen"),
    ids: z.array(Text(40)).max(16),
    other: Text(200).nullable(),
  }),
  z.strictObject({ answer: z.literal("skipped") }),
])

/** What a design question shows beside its options. */
export const DesignVisual = z.enum(["palette", "font_pair", "layout", "text"])

/** A question id: how an answer finds its question. */
const QuestionId = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/)

/** The most questions one tray holds. */
export const DESIGN_QUESTIONS_MAX = 8

/**
 * `ask_design`'s input: the design questions of a build, shown as one tray
 * the owner works through in any order. Each `card` is an ordinary
 * `AskChoiceInput`, so its limits, `other` and `skippable` mean what they do
 * there; `visual` says how the tray draws it. The api builds every card from
 * the contracts' lists, so an option is never the model's, and checks that
 * question ids are distinct and that no card takes several answers.
 */
export const AskDesignInput = z.strictObject({
  questions: z
    .array(
      z.strictObject({
        id: QuestionId,
        /** The question the tray shows; absent only in calls written before it existed. */
        question: Text(120).optional(),
        visual: DesignVisual,
        card: AskChoiceInput,
      })
    )
    .min(1)
    .max(DESIGN_QUESTIONS_MAX),
})

/** One answer in the tray: an option's id, the owner's own words, or a skip. */
const DesignAnswer = z.union([
  z.strictObject({ choice: Text(40) }),
  z.strictObject({ own: Text(200) }),
  z.strictObject({ skipped: z.literal(true) }),
])

/**
 * `ask_design`'s output, keyed by question id. A question the owner left
 * unopened has no entry; `skip_all` means they chose the defaults for every
 * question not answered. Card answers stay code-answered (ADR-037): the api
 * reads this against the call's own questions and no model sees the tray.
 */
export const AskDesignOutput = z.strictObject({
  answers: z.record(QuestionId, DesignAnswer),
  skip_all: z.boolean(),
})

/**
 * `review_blueprint`'s input: the plan the owner reads before a build starts.
 * `revision_of` is the assignment this plan revises, when it is a re-plan.
 */
export const BlueprintReviewInput = z.strictObject({
  blueprint: Blueprint,
  revision_of: Uuid.optional(),
})

/** Build it as planned, or change it: `note` is the owner's words and is data. */
export const BlueprintReviewOutput = z.discriminatedUnion("decision", [
  z.strictObject({ decision: z.literal("build"), note: Text(500).optional() }),
  z.strictObject({ decision: z.literal("change"), note: Text(500) }),
])

/**
 * `ask_upload`'s input: a drop zone for the owner's photos. The limits ride
 * on the wire so the web enforces what the api will.
 */
export const AskUploadInput = z.strictObject({
  accept: z.array(z.enum(UPLOAD_TYPES)).min(1),
  max_files: z.int().min(1).max(UPLOAD_MAX_FILES),
  max_bytes: z.int().positive().max(UPLOAD_MAX_BYTES),
  skippable: z.boolean(),
})

/**
 * `ask_upload`'s output: the photos the owner sent to `POST /assets` first,
 * by id. The api refuses an id it did not store for this org.
 */
export const AskUploadOutput = z.discriminatedUnion("answer", [
  z.strictObject({
    answer: z.literal("uploaded"),
    assets: z.array(Asset).min(1).max(UPLOAD_MAX_FILES),
  }),
  z.strictObject({ answer: z.literal("skipped") }),
])

/** The onboarding step a details card is for: a few related facts asked together. */
export const DetailsStep = z.enum(["contact", "assistant"])

/** The facts each details card asks for, in the order the card shows them. */
export const DETAILS_KEYS = {
  contact: ["business.phone", "business.email"],
  assistant: ["assistant.name", "assistant.pronouns", "assistant.tone"],
} as const satisfies Record<z.infer<typeof DetailsStep>, readonly string[]>

/**
 * `ask_details`'s input: one card for a few related facts, such as the phone
 * and email together. `prefill` holds the values to start from, such as the
 * sign-in email, only for the step's own keys. The copy, the inputs and the
 * pronoun and tone options are the web's, by key, as for `ask_fact`.
 */
export const AskDetailsInput = z
  .strictObject({
    step: DetailsStep,
    prefill: z.array(FactValue).max(3),
    skippable: z.boolean(),
  })
  .refine(
    (card) =>
      card.prefill.every((fact) =>
        (DETAILS_KEYS[card.step] as readonly string[]).includes(fact.key)
      ),
    { path: ["prefill"], message: "prefill holds only the step's own keys" }
  )

/**
 * `ask_details`'s output: the facts the owner stated, at least one. The api
 * refuses a key outside the call's step, a key stated twice, and a skip of a
 * card that is not skippable.
 */
export const AskDetailsOutput = z.discriminatedUnion("answer", [
  z.strictObject({
    answer: z.literal("stated"),
    facts: z.array(FactValue).min(1).max(3),
  }),
  z.strictObject({ answer: z.literal("skipped") }),
])

/**
 * `review_quote_form`'s input: the questions the assistant proposes for the
 * site's quote request form, drawn from what the owner said they need to
 * know to quote a job. The owner keeps, drops or marks each as required, or
 * asks for something else in their own words. `note` is one short line on
 * why these questions.
 */
export const ReviewQuoteFormInput = z.strictObject({
  fields: QuoteFields,
  note: Text(300).nullable(),
})

/**
 * `review_quote_form`'s output. `confirmed` carries the list the owner
 * settled on, which the api checks as `QuoteFields` and stores as the
 * `quote.form` fact. `changes` is what the owner wants different, as data for
 * the assistant's next proposal.
 */
export const ReviewQuoteFormOutput = z.discriminatedUnion("answer", [
  z.strictObject({ answer: z.literal("confirmed"), fields: QuoteFields }),
  z.strictObject({ answer: z.literal("changes"), text: Text(ANSWER_TEXT_MAX) }),
])

/**
 * `request_change`'s output once the owner said yes: the build it started,
 * or why it was refused. Its input is `OwnerChangeRequest`. A no is the AI
 * SDK's `output-denied`, with no output.
 */
export const RequestChangeOutput = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("started"), build: BuildSummary }),
  Refused,
])

/**
 * The owner's resolution of one pending call: an answer to `ask_fact`,
 * `ask_details`, `ask_choice`, `ask_upload` or `review_quote_form`, or a yes or no on a
 * call that needs approval.
 * The api reads `output` against the call's own tool.
 */
const ChatResult = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("answer"),
    tool_call_id: ToolCallId,
    output: z.union([
      AskFactOutput,
      AskDetailsOutput,
      AskChoiceOutput,
      AskDesignOutput,
      BlueprintReviewOutput,
      AskUploadOutput,
      ReviewQuoteFormOutput,
    ]),
  }),
  z.strictObject({
    kind: z.literal("approval"),
    approval_id: ApprovalId,
    approved: z.boolean(),
    /** The owner's words, as the AI SDK holds them: data, never instructions. */
    reason: Text(ANSWER_TEXT_MAX).optional(),
  }),
])

/**
 * An IANA zone name as the browser's `Intl` reports it, such as
 * `Europe/London`. The shape only: the api refuses a name `Intl` rejects.
 */
const TimeZone = z.string().regex(/^[A-Za-z][A-Za-z0-9_+/-]{0,63}$/)

/**
 * `POST /chat`: one turn of one conversation. The client sends only what
 * the owner just did; the server reads the history from its own rows and
 * never takes a message list, a system prompt or tools from the client.
 * `message_id` on a results turn names the stored assistant message that
 * holds the calls.
 */
export const ChatRequest = z.strictObject({
  conversation_id: Uuid,
  /**
   * Governs a typed message only. A results turn resolves the pending calls
   * it names, whatever the mode.
   */
  mode: z.enum(["ask", "act"]),
  /**
   * The owner's zone, so the Chief of Staff can read "Friday at 9" as a time.
   * Optional while older clients send none.
   */
  time_zone: TimeZone.optional(),
  /**
   * Set when the owner pressed Request changes on the website panel before
   * typing: the message describes a change to their website. Read on a
   * message turn only.
   */
  intent: z.enum(["site_change"]).optional(),
  turn: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("message"),
      message_id: MessageId,
      /** The owner's words: data, never instructions. */
      text: Text(GOAL_MAX),
    }),
    z.strictObject({
      kind: z.literal("results"),
      message_id: MessageId,
      /**
       * Every pending call of the message's last step, resolved, as the AI
       * SDK sends them together. The server refuses any other set with 409
       * `chat.stale`.
       */
      results: z.array(ChatResult).min(1),
      /**
       * An answer to an onboarding card as the owner's own message. The api
       * stores it after the card's message and gives the next step a message
       * of its own. Without it the next step continues the card's message.
       */
      reply: z
        .strictObject({
          message_id: MessageId,
          /** What the owner picked or wrote, in their words: data, never instructions. */
          text: Text(GOAL_MAX),
        })
        .optional(),
    }),
  ]),
})

export type ChoiceStep = z.infer<typeof ChoiceStep>
export type AskChoiceInput = z.infer<typeof AskChoiceInput>
export type AskChoiceOutput = z.infer<typeof AskChoiceOutput>
export type AskDesignInput = z.infer<typeof AskDesignInput>
export type BlueprintReviewInput = z.infer<typeof BlueprintReviewInput>
export type BlueprintReviewOutput = z.infer<typeof BlueprintReviewOutput>
export type AskDesignOutput = z.infer<typeof AskDesignOutput>
export type ReviewQuoteFormInput = z.infer<typeof ReviewQuoteFormInput>
export type ReviewQuoteFormOutput = z.infer<typeof ReviewQuoteFormOutput>
export type AskUploadInput = z.infer<typeof AskUploadInput>
export type AskUploadOutput = z.infer<typeof AskUploadOutput>
export type AskFactInput = z.infer<typeof AskFactInput>
export type DetailsStep = z.infer<typeof DetailsStep>
export type AskDetailsInput = z.infer<typeof AskDetailsInput>
export type AskDetailsOutput = z.infer<typeof AskDetailsOutput>
export type AskFactOutput = z.infer<typeof AskFactOutput>
export type RequestChangeOutput = z.infer<typeof RequestChangeOutput>
export type ChatRequest = z.infer<typeof ChatRequest>
export type ChatResult = z.infer<typeof ChatResult>
