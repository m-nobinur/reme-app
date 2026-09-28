import { z } from "zod"
import { Uuid } from "./common.ts"
import { ConversationMessage } from "./conversation.ts"
import { ToolCallId } from "./ids.ts"
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
 * The owner's resolution of one pending call: an answer to `ask_fact`, or a
 * yes or no on a call that needs approval.
 */
const ChatResult = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("answer"),
    tool_call_id: ToolCallId,
    output: AskFactOutput,
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
    }),
  ]),
})

export type AskFactInput = z.infer<typeof AskFactInput>
export type AskFactOutput = z.infer<typeof AskFactOutput>
export type RequestChangeOutput = z.infer<typeof RequestChangeOutput>
export type ChatRequest = z.infer<typeof ChatRequest>
export type ChatResult = z.infer<typeof ChatResult>
