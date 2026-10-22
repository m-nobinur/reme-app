import type { ToolCallMessagePartComponent } from "@assistant-ui/react"
import { TrayNote } from "@workspace/ui/components/assistant/question-tray"
import { askOpenView } from "@workspace/ui/lib/tool-state"

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

export { AskOpen }
