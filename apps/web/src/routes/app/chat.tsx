import { AssistantRuntimeProvider } from "@assistant-ui/react"
import {
  AssistantChatTransport,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk"
import { createFileRoute } from "@tanstack/react-router"
import { Approval } from "@workspace/ui/components/assistant/approval"
import { Thread } from "@workspace/ui/components/assistant/thread"
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai"

export const Route = createFileRoute("/app/chat")({
  component: ChatPage,
  // Client only. The thread is empty until the owner types, so rendering it on
  // the server produces nothing a reader would see, and it is what puts
  // assistant-ui and the AI SDK in the worker: 471 KiB gzip of the 1 MiB
  // budget for markup nobody reads.
  ssr: false,
})

function ChatPage() {
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({ api: "/api/chat" }),
    // An approval answer is a turn: once the owner has answered every pending
    // one, the runtime sends the thread back and the recording continues.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* The shell gives every other screen its own padding; the thread owns
          its scroll, so it takes the height instead. */}
      <div className="-my-6 h-[calc(100svh-3rem)] md:-my-10 md:h-[calc(100svh-5rem)]">
        <Thread components={{ ToolFallback: Approval }} />
      </div>
    </AssistantRuntimeProvider>
  )
}
