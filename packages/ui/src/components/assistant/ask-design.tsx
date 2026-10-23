import {
  type ToolCallMessagePartComponent,
  useAuiState,
} from "@assistant-ui/react"
import type { AskDesignOutput } from "@workspace/contracts"
import {
  Docked,
  QuestionTray,
  TrayNote,
} from "@workspace/ui/components/assistant/question-tray"
import { useSiteName } from "@workspace/ui/lib/site-name"
import { askDesignView } from "@workspace/ui/lib/tool-state"
import { createContext, useContext, useRef } from "react"

/**
 * The design questions of onboarding, in the question tray. An answer is
 * sent as the owner leaves its question (`SaveDesignAnswer`), so a reload
 * resumes after it; Build my site and Skip all answer the call. Once
 * answered the call shows nothing: the owner's reply after it says what they
 * picked.
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

const AskDesign: ToolCallMessagePartComponent = (props) => {
  const view = askDesignView(props)
  const save = useContext(SaveContext)
  const siteName = useSiteName()
  const messageId = useAuiState((s) => s.message.id)
  const conversationId = useAuiState((s) => s.threadListItem.remoteId)
  // The api runs one turn per conversation and answers a second at the same
  // moment `chat.busy`, so the saves go one after another and Build my site
  // waits for the last. What was sent stays here: a refused send reopens the
  // tray, and the owner's answers must still be in it.
  const saving = useRef<Promise<unknown>>(Promise.resolve())
  const sent = useRef<AskDesignOutput | null>(null)
  const sending = useRef<boolean>(false)

  if (view.state === "answered" || view.state === "skipped") return null
  if (view.state !== "pending") {
    return (
      <TrayNote
        error={view.state === "error" ? view.message : null}
        name="ask-design"
      />
    )
  }
  return (
    <Docked name="ask-design">
      <QuestionTray
        businessName={siteName}
        input={view.input}
        key={props.toolCallId}
        onAnswer={(id, answer) => {
          if (!save || !conversationId) return
          saving.current = saving.current.then(() =>
            save({
              conversationId,
              messageId,
              toolCallId: props.toolCallId,
              output: { answers: { [id]: answer }, skip_all: false },
            }).catch(() => undefined)
          )
        }}
        onFinish={(output) => {
          if (sending.current) return
          sending.current = true
          sent.current = output
          void saving.current.then(() => {
            sending.current = false
            props.addResult(output)
          })
        }}
        toolCallId={props.toolCallId}
        start={
          sent.current
            ? {
                answers: sent.current.answers,
                index: view.input.questions.length - 1,
              }
            : undefined
        }
      />
    </Docked>
  )
}
AskDesign.displayName = "AskDesign"

export { AskDesign }
