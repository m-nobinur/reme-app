import { AssistantRuntimeProvider } from "@assistant-ui/react"
import {
  AssistantChatTransport,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk"
import { useLocation, useRouter } from "@tanstack/react-router"
import { Approval } from "@workspace/ui/components/assistant/approval"
import { Thread } from "@workspace/ui/components/assistant/thread"
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai"

/**
 * The conversation, as `/app` and `/app/c/$id` both render it. Until
 * conversations are stored, an id names nothing and both start empty.
 *
 * Keyed on the navigation, so "New chat" and a move between conversations
 * start a fresh runtime instead of keeping the last thread on screen.
 */
export function ChatPage() {
  const key = useLocation({
    select: (location) => location.state.__TSR_key ?? location.href,
  })
  return <Conversation key={key} />
}

function Conversation() {
  const router = useRouter()
  const runtime = useChatRuntime({
    transport: new AssistantChatTransport({ api: "/api/chat" }),
    // An approval answer is a turn: once the owner has answered every pending
    // one, the runtime sends the thread back and the recording continues.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    // A turn can change what is waiting on the owner, so the frame reads it
    // again and the panel and its count are not left stale.
    onFinish: () => {
      void router.invalidate()
    },
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
