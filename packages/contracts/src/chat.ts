import { z } from "zod"
import { Uuid } from "./common.ts"
import { ConversationMessage } from "./conversation.ts"
import { ErrorEnvelope } from "./error.ts"
import { BuildSummary, FactValue, GOAL_MAX } from "./owner.ts"
import { Text } from "./text.ts"

const MessageId = ConversationMessage.shape.id

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
  z.strictObject({
    outcome: z.literal("refused"),
    error: ErrorEnvelope.omit({ occurred_at: true }),
  }),
])

/**
 * `POST /chat`: one turn of one conversation. The client sends only what
 * the owner just did; the server reads the history from its own rows and
 * never takes a message list, a system prompt or tools from the client.
 * `message_id` on an answer or an approval names the stored assistant
 * message that holds the call.
 */
export const ChatRequest = z.strictObject({
  conversation_id: Uuid,
  mode: z.enum(["ask", "act"]),
  turn: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("message"),
      message_id: MessageId,
      /** The owner's words: data, never instructions. */
      text: Text(GOAL_MAX),
    }),
    z.strictObject({
      kind: z.literal("answer"),
      message_id: MessageId,
      tool_call_id: MessageId,
      output: AskFactOutput,
    }),
    z.strictObject({
      kind: z.literal("approval"),
      message_id: MessageId,
      approval_id: MessageId,
      approved: z.boolean(),
    }),
  ]),
})

export type AskFactInput = z.infer<typeof AskFactInput>
export type AskFactOutput = z.infer<typeof AskFactOutput>
export type RequestChangeOutput = z.infer<typeof RequestChangeOutput>
export type ChatRequest = z.infer<typeof ChatRequest>
