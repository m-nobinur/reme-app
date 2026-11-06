import {
  defineToolkit,
  type ToolCallMessagePartComponent,
} from "@assistant-ui/react"
import {
  AskChoiceInput,
  AskDesignInput,
  AskDetailsInput,
  AskFactInput,
  AskUploadInput,
  ReviewQuoteFormInput,
} from "@workspace/contracts"
import { AskChoice } from "@workspace/ui/components/assistant/ask-choice"
import { AskDesign } from "@workspace/ui/components/assistant/ask-design"
import { AskDetails } from "@workspace/ui/components/assistant/ask-details"
import { AskFact } from "@workspace/ui/components/assistant/ask-fact"
import { AskOpen } from "@workspace/ui/components/assistant/ask-open"
import { AskUpload } from "@workspace/ui/components/assistant/ask-upload"
import {
  COS_CARDS,
  COS_QUIET,
  COS_READS,
} from "@workspace/ui/components/assistant/cos-tools"
import { RequestChange } from "@workspace/ui/components/assistant/request-change"
import { ReviewQuoteForm } from "@workspace/ui/components/assistant/review-quote-form"
import { isRepeat } from "@workspace/ui/lib/tool-state"

/** A call refused as a repeat of one its turn already ran shows nothing: the first one's result stands. */
const shown =
  (Card: ToolCallMessagePartComponent): ToolCallMessagePartComponent =>
  (props) =>
    isRepeat(props) ? null : <Card {...props} />

const backend = (
  cards: Record<string, ToolCallMessagePartComponent>,
  display?: "standalone"
) =>
  Object.fromEntries(
    Object.entries(cards).map(([name, Card]) => [
      name,
      {
        type: "backend" as const,
        ...(display && { display }),
        render: shown(Card),
      },
    ])
  )

/**
 * Every tool the api runs that has a card, registered with assistant-ui by
 * its name. The owner answers a human tool's card with `addResult`; a
 * backend tool's card shows its call, waits on an approval or says nothing.
 * Standalone keeps a card out of the folded tool group, where the owner
 * would have to go looking for it; the reads fold. Nothing here executes,
 * and the transport sends no tools, so the model sees only the api's.
 */
export const ownerToolkit = defineToolkit({
  ask_fact: { type: "human", parameters: AskFactInput, render: shown(AskFact) },
  ask_details: {
    type: "human",
    parameters: AskDetailsInput,
    render: shown(AskDetails),
  },
  ask_choice: {
    type: "human",
    parameters: AskChoiceInput,
    render: shown(AskChoice),
  },
  ask_design: {
    type: "human",
    parameters: AskDesignInput,
    render: shown(AskDesign),
  },
  ask_upload: {
    type: "human",
    parameters: AskUploadInput,
    render: shown(AskUpload),
  },
  review_quote_form: {
    type: "human",
    parameters: ReviewQuoteFormInput,
    render: shown(ReviewQuoteForm),
  },
  ...backend(
    {
      ask_open: AskOpen,
      request_change: RequestChange,
      ...COS_CARDS,
      ...COS_QUIET,
    },
    "standalone"
  ),
  ...backend(COS_READS),
})
