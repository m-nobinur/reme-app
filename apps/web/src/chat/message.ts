import type {
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
  AskUploadInput,
  AskUploadOutput,
  COS_TOOLS,
  ReviewQuoteFormInput,
  ReviewQuoteFormOutput,
} from "@workspace/contracts"
import type { UIDataTypes, UIMessage } from "ai"
import type { z } from "zod"

type Typed<T extends { input: z.ZodType; output: z.ZodType }> = {
  input: z.infer<T["input"]>
  output: z.infer<T["output"]>
}

/**
 * Every tool a conversation can hold, typed from its contract: the Chief of
 * Staff's `COS_TOOLS`, and the onboarding cards.
 */
type ChatTools = {
  [Name in keyof typeof COS_TOOLS]: Typed<(typeof COS_TOOLS)[Name]>
} & {
  ask_open: { input: AskOpenInput; output: AskOpenOutput }
  ask_fact: { input: AskFactInput; output: AskFactOutput }
  ask_details: { input: AskDetailsInput; output: AskDetailsOutput }
  ask_choice: { input: AskChoiceInput; output: AskChoiceOutput }
  ask_design: { input: AskDesignInput; output: AskDesignOutput }
  ask_upload: { input: AskUploadInput; output: AskUploadOutput }
  review_quote_form: {
    input: ReviewQuoteFormInput
    output: ReviewQuoteFormOutput
  }
}

/**
 * What a message's metadata carries: its stored date, the owner's thumb
 * where assistant-ui reads a submitted one, and, on a message sent here,
 * whether it is the owner's reply to a card rather than a typed message,
 * and whether the reply's words are ones they typed, such as changes to a
 * proposed quote form. `retry` marks the reply a failed turn left, which
 * offers Retry.
 */
type ChatMetadata = {
  custom?: { createdAt?: string; retry?: true }
  submittedFeedback?: { type: "positive" | "negative" }
  reply?: true
  typed?: true
}

/** A message as the chat holds it, with its tool parts typed. */
export type ChatMessage = UIMessage<ChatMetadata, UIDataTypes, ChatTools>
