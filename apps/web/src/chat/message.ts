import type {
  AskFactInput,
  AskFactOutput,
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
 * Staff's `COS_TOOLS`, and the onboarding script's `ask_fact`.
 */
export type ChatTools = {
  [Name in keyof typeof COS_TOOLS]: Typed<(typeof COS_TOOLS)[Name]>
} & { ask_fact: { input: AskFactInput; output: AskFactOutput } }

/**
 * What a message's metadata carries: its stored date, and the owner's thumb
 * where assistant-ui reads a submitted one.
 */
export type ChatMetadata = {
  custom?: { createdAt?: string }
  submittedFeedback?: { type: "positive" | "negative" }
}

/** A message as the chat holds it, with its tool parts typed. */
export type ChatMessage = UIMessage<ChatMetadata, UIDataTypes, ChatTools>
