import {
  AskChoiceInput,
  AskChoiceOutput,
  AskDesignInput,
  AskDesignOutput,
  AskDetailsInput,
  AskDetailsOutput,
  AskFactInput,
  AskFactOutput,
  AskUploadInput,
  AskUploadOutput,
  BlueprintReviewInput,
  BlueprintReviewOutput,
  type FactValue,
  type FactValueKey,
  PRONOUNS,
  ReviewQuoteFormInput,
  ReviewQuoteFormOutput,
  TONES,
  TOOL_CALL_CANCELLED,
  toolErrorKind,
} from "@workspace/contracts"
import { factText } from "@workspace/ui/lib/facts"

/**
 * What the owner sees of an `ask_fact` or a `request_change` call, read from
 * the part the runtime hands a tool UI. One function per tool, so the card
 * never branches on raw part fields and a unit test covers every state.
 */

/** The fields of a tool-call part these views read. */
export type ToolPartView = {
  args: unknown
  result?: unknown
  isError?: boolean | undefined
  approval?: { approved?: boolean | undefined } | undefined
}

/** `{ error }` on a failed part, as `@assistant-ui/ai-sdk` 0.0.2 sets it. */
const errorOf = (result: unknown): string =>
  result && typeof result === "object" && "error" in result
    ? String((result as { error: unknown }).error)
    : ""

/** A turn's error when the session behind it has ended; the thread offers sign-in. */
export const SESSION_ENDED =
  "Your session has ended. Sign in again to carry on."

export const BROKEN = "This step did not come through. Reload the conversation."

/**
 * Why a call ended without an output, from the contracts' own reading of
 * the api's error text, which is written for the model and never shown.
 * Only a `failed` error says nothing was done; any other may follow a side
 * effect that happened, so the owner is told to check before asking again.
 */
export type Failure = "cancelled" | "unconfirmed" | "failed"

const failureOf = (result: unknown): Failure => {
  const text = errorOf(result)
  if (text === TOOL_CALL_CANCELLED) return "cancelled"
  return toolErrorKind(text) === "failed" ? "failed" : "unconfirmed"
}

/** What a failed act tool tells the owner. */
export const NOT_DONE = "This did not go through. Ask again."
export const UNCONFIRMED =
  "We could not confirm this went through. Check the panel before you ask again."

/** A contract schema, as far as these views use one. */
type Schema<T> = {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false }
}

/** A tool that reads and asks nobody: still running, done, or ended early. */
export type ReadView<O> =
  | { state: "working" }
  | { state: "done"; output: O }
  | { state: Failure }

export function readView<O>(
  part: ToolPartView,
  output: Schema<O>
): ReadView<O> {
  if (part.isError) return { state: failureOf(part.result) }
  if (part.result === undefined) return { state: "working" }
  const parsed = output.safeParse(part.result)
  return parsed.success
    ? { state: "done", output: parsed.data }
    : { state: "failed" }
}

/**
 * A tool that waits for the owner's yes. `drafting` is the call before its
 * approval request exists, while the model is still writing it: there is
 * nothing to approve yet. A call whose input does not parse is `broken` and
 * never offers a yes, because the owner could not see what they approve;
 * `waiting` says whether it still needs a no to let its step go on. A
 * refusal is its own state. A call that succeeded but whose output does not
 * parse is still `done`, with no details, so the owner is not invited to do
 * it again.
 */
export type DecisionView<I, O> =
  | { state: "drafting" }
  | { state: "broken"; waiting: boolean }
  | { state: "asking"; input: I }
  | { state: "responding"; input: I; approved: boolean }
  | { state: "done"; input: I; output: O | null }
  | { state: "refused"; input: I; code: string | null }
  | { state: "denied"; input: I }
  | { state: Failure; input: I | null }

/** A refusal's code, read as far as it goes. */
function refusalOf(result: unknown): { code: string | null } | null {
  if (!result || typeof result !== "object") return null
  const { outcome, error } = result as { outcome?: unknown; error?: unknown }
  if (outcome !== "refused") return null
  const code =
    error && typeof error === "object" && "code" in error
      ? (error as { code: unknown }).code
      : null
  return { code: typeof code === "string" && code ? code : null }
}

export function decisionView<I, O>(
  part: ToolPartView,
  input: Schema<I>,
  output: Schema<O>
): DecisionView<I, O> {
  const args = input.safeParse(part.args)
  const approved = part.approval?.approved
  if (part.isError) {
    // A no is `output-denied`, reported as an error that keeps the answer.
    if (approved === false) {
      return args.success
        ? { state: "denied", input: args.data }
        : { state: "broken", waiting: false }
    }
    const failure = failureOf(part.result)
    return { state: failure, input: args.success ? args.data : null }
  }
  if (part.result === undefined && part.approval == null) {
    return { state: "drafting" }
  }
  if (!args.success) {
    return {
      state: "broken",
      waiting: part.result === undefined && approved === undefined,
    }
  }
  if (part.result === undefined) {
    return approved === undefined
      ? { state: "asking", input: args.data }
      : { state: "responding", input: args.data, approved }
  }
  const refused = refusalOf(part.result)
  if (refused) return { state: "refused", input: args.data, ...refused }
  const parsed = output.safeParse(part.result)
  return {
    state: "done",
    input: args.data,
    output: parsed.success ? parsed.data : null,
  }
}

export type AskFactView = { key: FactValueKey | null } & (
  | { state: "pending"; input: AskFactInput }
  | { state: "answered"; fact: FactValue }
  | { state: "skipped" }
  | { state: "cancelled" }
  | { state: "error"; message: string }
)

/**
 * Fact keys an older onboarding asked for and the contract has since dropped.
 * Their cards, answered or not, stay in stored conversations; they read as
 * skipped, so they show nothing rather than a broken card.
 */
const RETIRED_KEYS: readonly string[] = ["pricing.standard_clean_hourly"]

export function askFactView(part: ToolPartView): AskFactView {
  const asked = (part.args as { key?: unknown } | null)?.key
  if (typeof asked === "string" && RETIRED_KEYS.includes(asked)) {
    return { key: null, state: "skipped" }
  }
  const input = AskFactInput.safeParse(part.args)
  const key = input.success ? input.data.key : null
  if (part.isError) {
    const message = errorOf(part.result)
    return message === TOOL_CALL_CANCELLED
      ? { key, state: "cancelled" }
      : { key, state: "error", message: message || BROKEN }
  }
  if (part.result === undefined) {
    return input.success
      ? { key, state: "pending", input: input.data }
      : { key, state: "error", message: BROKEN }
  }
  const output = AskFactOutput.safeParse(part.result)
  if (!output.success) return { key, state: "error", message: BROKEN }
  return output.data.answer === "stated"
    ? { key, state: "answered", fact: output.data.fact }
    : { key, state: "skipped" }
}

/**
 * An `ask_choice` or `ask_upload` card: waiting, answered, skipped, overtaken
 * by a typed message, or broken. `input` rides along once answered, so the
 * answer can be read back in the words the owner saw.
 */
export type AskView<I, O> =
  | { state: "pending"; input: I }
  | { state: "answered"; input: I | null; output: O }
  | { state: "skipped" }
  | { state: "cancelled" }
  | { state: "error"; message: string }

function askView<I, O extends { answer: string }>(
  part: ToolPartView,
  input: Schema<I>,
  output: Schema<O>
): AskView<I, Exclude<O, { answer: "skipped" }>> {
  const args = input.safeParse(part.args)
  if (part.isError) {
    const message = errorOf(part.result)
    return message === TOOL_CALL_CANCELLED
      ? { state: "cancelled" }
      : { state: "error", message: message || BROKEN }
  }
  if (part.result === undefined) {
    return args.success
      ? { state: "pending", input: args.data }
      : { state: "error", message: BROKEN }
  }
  const parsed = output.safeParse(part.result)
  if (!parsed.success) return { state: "error", message: BROKEN }
  if (parsed.data.answer === "skipped") return { state: "skipped" }
  return {
    state: "answered",
    input: args.success ? args.data : null,
    output: parsed.data as Exclude<O, { answer: "skipped" }>,
  }
}

export type AskChoiceView = AskView<
  AskChoiceInput,
  Extract<AskChoiceOutput, { answer: "chosen" }>
>
export const askChoiceView = (part: ToolPartView): AskChoiceView =>
  askView(part, AskChoiceInput, AskChoiceOutput)

/**
 * An `ask_design` tray: waiting, answered, overtaken by a typed message or
 * broken. Its answers are read back in the owner's reply, so an answered
 * tray shows nothing.
 */
export type AskDesignView = AskView<AskDesignInput, AskDesignOutput>
export function askDesignView(part: ToolPartView): AskDesignView {
  const args = AskDesignInput.safeParse(part.args)
  if (part.isError) {
    const message = errorOf(part.result)
    return message === TOOL_CALL_CANCELLED
      ? { state: "cancelled" }
      : { state: "error", message: message || BROKEN }
  }
  if (part.result === undefined) {
    return args.success
      ? { state: "pending", input: args.data }
      : { state: "error", message: BROKEN }
  }
  const output = AskDesignOutput.safeParse(part.result)
  return output.success
    ? {
        state: "answered",
        input: args.success ? args.data : null,
        output: output.data,
      }
    : { state: "error", message: BROKEN }
}

export type AskUploadView = AskView<
  AskUploadInput,
  Extract<AskUploadOutput, { answer: "uploaded" }>
>
export const askUploadView = (part: ToolPartView): AskUploadView =>
  askView(part, AskUploadInput, AskUploadOutput)

/**
 * An `ask_details` card: a few related facts on one card, such as the phone
 * and email together, or the assistant's name, pronouns and tone.
 */
export type AskDetailsView = AskView<
  AskDetailsInput,
  Extract<AskDetailsOutput, { answer: "stated" }>
>
export const askDetailsView = (part: ToolPartView): AskDetailsView =>
  askView(part, AskDetailsInput, AskDetailsOutput)

/**
 * A UK number as it is written at home: `+447700900123` as `07700 900123`.
 * Any other number stays as it is.
 */
export function phoneText(e164: string): string {
  const national = /^\+44(\d{10})$/.exec(e164)?.[1]
  if (!national) return e164
  // ponytail: two groupings, London-style 02x and five-then-six for the
  // rest; a full UK numbering plan only if owners read these as wrong.
  return national.startsWith("2")
    ? `0${national.slice(0, 2)} ${national.slice(2, 6)} ${national.slice(6)}`
    : `0${national.slice(0, 4)} ${national.slice(4)}`
}

/**
 * Details as the owner gave them, in the card's order and the words it
 * showed: "07700 900123, hello@example.com" or "Ava, she/her, Friendly".
 */
export function detailsText(facts: readonly FactValue[]): string {
  return facts
    .map((fact) => {
      if (fact.key === "business.phone") return phoneText(fact.value.e164)
      if (fact.key === "assistant.pronouns" || fact.key === "assistant.tone") {
        const presets: readonly { id: string; label: string }[] =
          fact.key === "assistant.pronouns" ? PRONOUNS : TONES
        return (
          presets.find((each) => each.id === fact.value.id)?.label ??
          fact.value.id
        )
      }
      return factText(fact.key, fact.value)
    })
    .join(", ")
}

/**
 * A `review_quote_form` card: the proposed questions waiting, the list the
 * owner confirmed, the change they asked for in their own words, overtaken,
 * or broken. It has no skip: a form the owner does not want is a change.
 */
export type ReviewQuoteFormView = AskView<
  ReviewQuoteFormInput,
  ReviewQuoteFormOutput
>
export const reviewQuoteFormView = (part: ToolPartView): ReviewQuoteFormView =>
  askView(part, ReviewQuoteFormInput, ReviewQuoteFormOutput)

/**
 * A `review_blueprint` card: the plan waiting for the owner's build or change,
 * their decision, overtaken by a typed message, or broken. It has no skip: a
 * plan the owner does not want is a change.
 */
export type BlueprintReviewView =
  | { state: "pending"; input: BlueprintReviewInput }
  | {
      state: "answered"
      input: BlueprintReviewInput | null
      output: BlueprintReviewOutput
    }
  | { state: "cancelled" }
  | { state: "error"; message: string }

export function blueprintReviewView(part: ToolPartView): BlueprintReviewView {
  const args = BlueprintReviewInput.safeParse(part.args)
  if (part.isError) {
    const message = errorOf(part.result)
    return message === TOOL_CALL_CANCELLED
      ? { state: "cancelled" }
      : { state: "error", message: message || BROKEN }
  }
  if (part.result === undefined) {
    return args.success
      ? { state: "pending", input: args.data }
      : { state: "error", message: BROKEN }
  }
  const output = BlueprintReviewOutput.safeParse(part.result)
  return output.success
    ? {
        state: "answered",
        input: args.success ? args.data : null,
        output: output.data,
      }
    : { state: "error", message: BROKEN }
}

/**
 * A choice as the owner reads it back: the labels they picked, in the card's
 * order, then their own words. An id the card no longer offers reads as
 * itself rather than vanishing.
 */
export function choiceText(
  input: AskChoiceInput | null,
  output: { ids: string[]; other: string | null }
): string {
  const labels = output.ids.map(
    (id) => input?.options.find((option) => option.id === id)?.label ?? id
  )
  return [...labels, ...(output.other ? [output.other] : [])].join(", ")
}

/**
 * A finished design tray as the owner's words: each answered question as
 * "Question: answer", their own words as typed. A question skipped or never
 * opened is left out, and Skip all with nothing answered says so.
 */
export function designText(
  input: AskDesignInput | null,
  output: AskDesignOutput
): string {
  const lines = (input?.questions ?? []).flatMap((each) => {
    const answer = output.answers[each.id]
    if (!answer || "skipped" in answer) return []
    const said =
      "own" in answer
        ? answer.own
        : (each.card.options.find((option) => option.id === answer.choice)
            ?.label ?? answer.choice)
    return [`${each.question ?? each.id}: ${said}`]
  })
  if (lines.length > 0) return lines.join("\n")
  return output.skip_all
    ? "Skip all: you choose the look."
    : "No preferences on the look."
}

/** The fields of a message part `isHeld` reads. */
type CallPart = {
  type: string
  toolCallId?: string
  approval?: { approved?: boolean | undefined } | undefined
  result?: unknown
  isError?: boolean | undefined
}

const unresolved = (part: CallPart) =>
  part.result === undefined && !part.isError

/**
 * The owner answered this call while another call in its message still
 * waits for a yes or no, so the step has not been sent and nothing is
 * running for it. Only the last step holds calls that wait, so the message
 * stands in for the step. A call answered and sent, with no other call
 * waiting, is not held.
 */
export function isHeld(parts: readonly object[], toolCallId: string): boolean {
  const calls = (parts as CallPart[]).filter((p) => p.type === "tool-call")
  const self = calls.find((p) => p.toolCallId === toolCallId)
  return (
    self !== undefined &&
    unresolved(self) &&
    self.approval?.approved !== undefined &&
    calls.some(
      (p) =>
        p !== self &&
        unresolved(p) &&
        p.approval != null &&
        p.approval.approved === undefined
    )
  )
}

/** What a held answer says, on every card that can be held. */
export const heldText = (approved: boolean) =>
  `${approved ? "You said yes." : "You said not now."} Sent once you answer the other cards.`

/** Whether these parts, a message's, hold design questions still waiting on the owner. */
export const waitsOnDesign = (parts: readonly object[] | undefined) =>
  (parts ?? []).some((part) => {
    const p = part as {
      type?: string
      toolName?: string
      result?: unknown
      isError?: boolean
    }
    return (
      p.type === "tool-call" &&
      p.toolName === "ask_design" &&
      p.result === undefined &&
      !p.isError
    )
  })
