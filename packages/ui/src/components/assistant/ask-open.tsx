import type { ToolCallMessagePartComponent } from "@assistant-ui/react"
import { TrayNote } from "@workspace/ui/components/assistant/question-tray"
import { askable, saidInChat } from "@workspace/ui/lib/answer"
import {
  askFactView,
  askOpenView,
  type ToolPartView,
} from "@workspace/ui/lib/tool-state"

/**
 * A question onboarding asks in words. The assistant's message asks it and
 * the owner answers in the composer, as they would anyone: no card, since a
 * text box above the composer is a second place to type the same thing. Only
 * a call that broke says so, in the tray's note.
 */
const AskOpen: ToolCallMessagePartComponent = (props) => {
  const view = askOpenView(props)
  if (view.state !== "error" && view.state !== "cancelled") return null
  return (
    <TrayNote
      error={view.state === "error" ? view.message : null}
      name="ask-open"
    />
  )
}
AskOpen.displayName = "AskOpen"

/**
 * Whether these parts, a message's, wait on an optional question the owner
 * answers in the composer: an `ask_open`, or a fact said in the chat.
 */
const waitsToSkip = (parts: readonly object[] | undefined) =>
  (parts ?? []).some((part) => {
    const p = part as ToolPartView & { type?: string; toolName?: string }
    if (p.type !== "tool-call") return false
    if (p.toolName === "ask_open") {
      const view = askOpenView(p)
      return view.state === "pending" && view.input.skippable === true
    }
    if (p.toolName !== "ask_fact") return false
    const view = askFactView(p)
    return (
      view.state === "pending" &&
      view.input.skippable &&
      askable(view.input.key) &&
      saidInChat(view.input.key)
    )
  })

export { AskOpen, waitsToSkip }
