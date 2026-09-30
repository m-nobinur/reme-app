import type {
  AskChoiceInput,
  AskChoiceOutput,
  AskFactInput,
  AskFactOutput,
  AskUploadInput,
  AskUploadOutput,
  COS_TOOLS,
} from "@workspace/contracts"
import type { UIDataTypes, UIMessage } from "ai"
import type { z } from "zod"

type Typed<T extends { input: z.ZodType; output: z.ZodType }> = {
  input: z.infer<T["input"]>
  output: z.infer<T["output"]>
}

/**
 * Every tool a conversation can hold, typed from its contract: the Chief of
 * Staff's `COS_TOOLS`, and the onboarding script's three cards.
 */
export type ChatTools = {
  [Name in keyof typeof COS_TOOLS]: Typed<(typeof COS_TOOLS)[Name]>
} & {
  ask_fact: { input: AskFactInput; output: AskFactOutput }
  ask_choice: { input: AskChoiceInput; output: AskChoiceOutput }
  ask_upload: { input: AskUploadInput; output: AskUploadOutput }
}

/**
 * What a message's metadata carries: its stored date, the owner's thumb
 * where assistant-ui reads a submitted one, and, on a message sent here,
 * whether it is the owner's reply to a card rather than a typed message.
 */
export type ChatMetadata = {
  custom?: { createdAt?: string }
  submittedFeedback?: { type: "positive" | "negative" }
  reply?: true
}

/** A message as the chat holds it, with its tool parts typed. */
export type ChatMessage = UIMessage<ChatMetadata, UIDataTypes, ChatTools>
