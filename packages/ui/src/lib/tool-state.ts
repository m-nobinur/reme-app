import {
  AskFactInput,
  AskFactOutput,
  type FactValue,
  type FactValueKey,
  TOOL_CALL_CANCELLED,
  toolErrorKind,
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
