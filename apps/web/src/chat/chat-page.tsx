import { AssistantRuntimeProvider } from "@assistant-ui/react"
import {
  AssistantChatTransport,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk"
import { Approval } from "@workspace/ui/components/assistant/approval"
import { Thread } from "@workspace/ui/components/assistant/thread"
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai"

/**
 * The conversation, as `/app` and `/app/c/$id` both render it. Until
 * conversations are stored, an id names nothing and both start empty.
 */
export function ChatPage() {
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({ api: "/api/chat" }),
    // An approval answer is a turn: once the owner has answered every pending
    // one, the runtime sends the thread back and the recording continues.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* The shell's main scrolls; the thread owns its own scroll instead. */}
      <div className="h-full">
        <Thread components={{ ToolFallback: Approval }} />
      </div>
    </AssistantRuntimeProvider>
  )
}
