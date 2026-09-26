import {
  AssistantRuntimeProvider,
  WebSpeechDictationAdapter,
} from "@assistant-ui/react"
import {
  AssistantChatTransport,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk"
import { getRouteApi, useLocation, useRouter } from "@tanstack/react-router"
import { Approval } from "@workspace/ui/components/assistant/approval"
import {
  Thread,
  type ThreadMode,
  type ThreadQuickAction,
} from "@workspace/ui/components/assistant/thread"
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai"
import { useMemo, useState } from "react"
import { briefingOf } from "@/lib/briefing"

const frame = getRouteApi("/app")

/** What "+" offers: sentences the owner finishes, never a send on their behalf. */
const QUICK_ACTIONS: ThreadQuickAction[] = [
  { title: "Change my website", prompt: "On my website, please change " },
  { title: "Check what needs me", prompt: "What is waiting on me?" },
]

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
  const { active, workspace } = frame.useLoaderData()
  const briefing = useMemo(
    () => briefingOf(active, workspace),
    [active, workspace]
  )
  // Held here and not yet sent: the Chief of Staff reads it once it runs as
  // an agent. Until then the replay answers the same either way.
  const [mode, setMode] = useState<ThreadMode>("act")
  // Client only (the route has `ssr: false`), so the browser can be asked.
  const [dictation] = useState(() =>
    WebSpeechDictationAdapter.isSupported()
      ? new WebSpeechDictationAdapter({ language: "en-GB" })
      : undefined
  )
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
    // The option, not `adapters.suggestion`: in @assistant-ui/react-ai-sdk 1.4.7
    // the adapter runs only after an assistant turn ends and then replaces these,
    // and the empty thread is the only place suggestions show.
    suggestions: briefing.suggestions,
    adapters: dictation ? { dictation } : {},
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* The shell's main scrolls; the thread owns its own scroll instead. */}
      <div className="h-full">
        <Thread
          briefing={briefing.line}
          components={{ ToolFallback: Approval }}
          context={briefing.context}
          mode={mode}
          onModeChange={setMode}
          placeholder="Ask, or tell me what to change"
          quickActions={QUICK_ACTIONS}
        />
      </div>
    </AssistantRuntimeProvider>
  )
}
