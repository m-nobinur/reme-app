import { z } from "zod"
import { Uuid } from "./common.ts"
import { ConversationMessage } from "./conversation.ts"
import { ToolCallId } from "./ids.ts"
import {
  Asset,
  HexColour,
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
 * `ask_choice` or `ask_upload`, or a yes or no on a call that needs approval.
 * The api reads `output` against the call's own tool.
 */
const ChatResult = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("answer"),
    tool_call_id: ToolCallId,
    output: z.union([AskFactOutput, AskChoiceOutput, AskUploadOutput]),
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
export type AskUploadInput = z.infer<typeof AskUploadInput>
export type AskUploadOutput = z.infer<typeof AskUploadOutput>
export type AskFactInput = z.infer<typeof AskFactInput>
export type AskFactOutput = z.infer<typeof AskFactOutput>
export type RequestChangeOutput = z.infer<typeof RequestChangeOutput>
export type ChatRequest = z.infer<typeof ChatRequest>
export type ChatResult = z.infer<typeof ChatResult>
