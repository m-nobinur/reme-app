import {
  AskFactInput,
  AskFactOutput,
  type FactValue,
  type FactValueKey,
  OwnerChangeRequest,
  RequestChangeOutput,
  TOOL_CALL_CANCELLED,
} from "@workspace/contracts"

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
 * Why a call ended without an output. The api's error text is written for
 * the model, so it is read only for the cancel marker and the "unknown
 * outcome" prefix `toolErrorText` gives it, and never shown.
 */
export type Failure = "cancelled" | "unconfirmed" | "failed"

const failureOf = (result: unknown): Failure => {
  const text = errorOf(result)
  if (text === TOOL_CALL_CANCELLED) return "cancelled"
  return text.startsWith("unknown_outcome") ? "unconfirmed" : "failed"
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
 * never offers a yes, because the owner could not see what they approve.
 */
export type DecisionView<I, O> =
  | { state: "drafting" }
  | { state: "broken" }
  | { state: "asking"; input: I }
  | { state: "responding"; input: I; approved: boolean }
  | { state: "done"; input: I; output: O }
  | { state: "denied"; input: I }
  | { state: Failure; input: I | null }

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
      return args.success ? { state: "denied", input: args.data } : BROKE
    }
    const failure = failureOf(part.result)
    return { state: failure, input: args.success ? args.data : null }
  }
  if (part.result === undefined && part.approval == null) {
    return { state: "drafting" }
  }
  if (!args.success) return BROKE
  if (part.result === undefined) {
    return approved === undefined
      ? { state: "asking", input: args.data }
      : { state: "responding", input: args.data, approved }
  }
  const parsed = output.safeParse(part.result)
  return parsed.success
    ? { state: "done", input: args.data, output: parsed.data }
    : BROKE
}

const BROKE = { state: "broken" } as const

export type AskFactView = { key: FactValueKey | null } & (
  | { state: "pending"; input: AskFactInput }
  | { state: "answered"; fact: FactValue }
  | { state: "skipped" }
  | { state: "cancelled" }
  | { state: "error"; message: string }
)

export function askFactView(part: ToolPartView): AskFactView {
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

export type RequestChangeView =
  /** The model is still writing the change: nothing to approve yet. */
  | { state: "drafting"; text: string }
  | { state: "approval-requested"; text: string }
  /** The owner answered and the server has not yet. */
  | { state: "responding"; text: string; approved: boolean }
  | {
      state: "started"
      text: string
      output: Extract<RequestChangeOutput, { outcome: "started" }>
    }
  | { state: "refused"; text: string; message: string }
  | { state: "denied"; text: string }
  | { state: "cancelled"; text: string }
  | { state: "error"; text: string; message: string }

export function requestChangeView(part: ToolPartView): RequestChangeView {
  const input = OwnerChangeRequest.safeParse(part.args)
  const text = input.success ? input.data.text : ""
  const approved = part.approval?.approved
  if (part.isError) {
    // A no is `output-denied`, which the runtime reports as an error that
    // still carries the owner's answer. A cancel strips the approval.
    if (approved === false) return { state: "denied", text }
    const failure = failureOf(part.result)
    return failure === "cancelled"
      ? { state: "cancelled", text }
      : {
          state: "error",
          text,
          message: failure === "unconfirmed" ? UNCONFIRMED : NOT_DONE,
        }
  }
  if (part.result === undefined) {
    if (part.approval == null) return { state: "drafting", text }
    return approved === undefined
      ? { state: "approval-requested", text }
      : { state: "responding", text, approved }
  }
  const output = RequestChangeOutput.safeParse(part.result)
  if (!output.success) return { state: "error", text, message: BROKEN }
  return output.data.outcome === "started"
    ? { state: "started", text, output: output.data }
    : { state: "refused", text, message: output.data.error.message }
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
