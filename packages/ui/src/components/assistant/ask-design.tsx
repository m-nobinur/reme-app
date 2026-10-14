import {
  type ToolCallMessagePartComponent,
  useAuiState,
} from "@assistant-ui/react"
import type { AskDesignOutput } from "@workspace/contracts"
import { QuestionTray } from "@workspace/ui/components/assistant/question-tray"
import {
  useFocusWhenIdle,
  useRevealWaiting,
} from "@workspace/ui/hooks/use-reveal-waiting"
import { askDesignView } from "@workspace/ui/lib/tool-state"
import { cn } from "@workspace/ui/lib/utils"
import { createContext, useContext, useRef } from "react"
import { createPortal } from "react-dom"

/**
 * The design tray of onboarding. The call sits in the transcript like any
 * card, but the tray is drawn above the composer, in the slot the thread
 * keeps there, so it docks at the composer's width and stays put while the
 * owner scrolls or types. An answer is sent as the owner leaves its
 * question (`SaveDesignAnswer`), so a reload resumes after it; Build my site
 * and Skip all answer the call. Once answered the call shows nothing: the
 * owner's reply after it says what they picked.
 */

/** Stores one answer of the tray; failures are the tray's to ignore, the final answer carries them all. */
export type SaveDesignAnswer = (answer: {
  conversationId: string
  messageId: string
  toolCallId: string
  output: AskDesignOutput
}) => Promise<void>

const SaveContext = createContext<SaveDesignAnswer | null>(null)

/** Gives the tray the app's way to store an answer as it is given. */
export const SaveDesignAnswerProvider = SaveContext.Provider

const SlotContext = createContext<HTMLElement | null>(null)

/** The element above the composer the tray docks into, set by the thread. */
export const TraySlotProvider = SlotContext.Provider

const AskDesign: ToolCallMessagePartComponent = (props) => {
  const view = askDesignView(props)
  const slot = useContext(SlotContext)
  const save = useContext(SaveContext)
  const messageId = useAuiState((s) => s.message.id)
  const conversationId = useAuiState((s) => s.threadListItem.remoteId)
  const waiting = view.state === "pending"
  const running = useRevealWaiting(waiting)
  const tray = useRef<HTMLDivElement>(null)
  useFocusWhenIdle(waiting, running, tray)

  if (view.state === "answered" || view.state === "skipped") return null
  if (view.state !== "pending") {
    return (
      <p
        className={cn(
          "my-3 text-sm",
          view.state === "error" ? "text-destructive" : "text-muted-foreground"
        )}
        data-slot="ask-design"
      >
        {view.state === "cancelled"
          ? "You replied in the chat instead."
          : view.message}
      </p>
    )
  }
  if (!slot) return null
  return createPortal(
    <div data-slot="ask-design" ref={tray}>
      <QuestionTray
        input={view.input}
        key={props.toolCallId}
        onAnswer={(id, answer) => {
          if (!save || !conversationId) return
          void save({
            conversationId,
            messageId,
            toolCallId: props.toolCallId,
            output: { answers: { [id]: answer }, skip_all: false },
          }).catch(() => undefined)
        }}
        onFinish={(output) => props.addResult(output)}
      />
    </div>,
    slot
  )
}
AskDesign.displayName = "AskDesign"

export { AskDesign }
