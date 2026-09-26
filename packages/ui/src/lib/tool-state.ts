import {
  AskFactInput,
  AskFactOutput,
  type FactValue,
  type FactValueKey,
  OwnerChangeRequest,
  RequestChangeOutput,
} from "@workspace/contracts"

/**
 * What the owner sees of an `ask_fact` or a `request_change` call, read from
 * the part the runtime hands a tool UI. One function per tool, so the card
 * never branches on raw part fields and a unit test covers every state.
 */

/**
 * The tools with a card of their own. Each is part of the conversation, so
 * none is ever folded into a tool group.
 */
export const OWNER_TOOLS: readonly string[] = ["ask_fact", "request_change"]

/**
 * assistant-ui's words for a call a typed message overtook. `apps/api`
 * stores the same string, so a reload reads the same state as the live view.
 */
export const CANCELLED = "User cancelled tool call by sending a new message."

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

const BROKEN = "This step did not come through. Reload the conversation."

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
    return message === CANCELLED
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
    const message = errorOf(part.result)
    return message === CANCELLED
      ? { state: "cancelled", text }
      : { state: "error", text, message: message || BROKEN }
  }
  if (part.result === undefined) {
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
