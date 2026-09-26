import {
  AssistantRuntimeProvider,
  useRemoteThreadListRuntime,
  WebSpeechDictationAdapter,
} from "@assistant-ui/react"
import {
  AssistantChatTransport,
  useChatRuntime,
} from "@assistant-ui/react-ai-sdk"
import {
  getRouteApi,
  useLocation,
  useNavigate,
  useParams,
} from "@tanstack/react-router"
import { Approval } from "@workspace/ui/components/assistant/approval"
import {
  OWNER_QUICK_ACTIONS,
  Thread,
  type ThreadMode,
} from "@workspace/ui/components/assistant/thread"
import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { briefingOf } from "@/lib/briefing"
import { useLiveWorkspace } from "@/lib/workspace"
import { conversationList, unstored } from "./conversations"

const frame = getRouteApi("/app")

/**
 * The mode outlives a conversation: "New chat" and a move between chats keep
 * what the owner picked. Per tab, and a storage failure is only a default.
 */
const MODE_KEY = "reme-mode"

function storedMode(): ThreadMode {
  try {
    return sessionStorage.getItem(MODE_KEY) === "ask" ? "ask" : "act"
  } catch {
    return "act"
  }
}

function storeMode(mode: ThreadMode) {
  try {
    sessionStorage.setItem(MODE_KEY, mode)
  } catch {
    // The choice still holds for this conversation.
  }
}

/**
 * The conversation at `/app` (a new one) and `/app/c/$id` (a stored one).
 * The address is the thread: the runtime follows `id`, and when a new
 * chat's first send stores it, the address follows the stored id.
 */
export function ChatPage() {
  const navigate = useNavigate()
  const { id } = useParams({ strict: false })
  const { refresh } = useLiveWorkspace()
  const { active, workspace } = frame.useLoaderData()
  const briefing = useMemo(
    () => briefingOf(active, workspace),
    [active, workspace]
  )
  // Client only (the route has `ssr: false`), so storage can be read here.
  const [mode, setMode] = useState(storedMode)
  const changeMode = useCallback((next: ThreadMode) => {
    setMode(next)
    storeMode(next)
  }, [])
  // Client only (the route has `ssr: false`), so the browser can be asked.
  const [dictation] = useState(() =>
    WebSpeechDictationAdapter.isSupported()
      ? new WebSpeechDictationAdapter({ language: "en-GB" })
      : undefined
  )
  const useThreadRuntime = () =>
    useChatRuntime({
      // The mode travels with every request, so the backend that enforces it
      // (the onboarding script, then the Chief of Staff) reads what the owner
      // picked. The replay ignores it.
      transport: new AssistantChatTransport({
        api: "/api/chat",
        body: { mode },
      }),
      // An approval answer is a turn: once the owner has answered every pending
      // one, the runtime sends the thread back and the recording continues.
      sendAutomaticallyWhen:
        lastAssistantMessageIsCompleteWithApprovalResponses,
      // A turn can change what is waiting on the owner, so the panel reads
      // it again rather than waiting for its next poll.
      onFinish: () => {
        void refresh()
      },
      // The option, not `adapters.suggestion`: in @assistant-ui/react-ai-sdk 1.4.7
      // the adapter runs only after an assistant turn ends and then replaces these,
      // and the empty thread is the only place suggestions show.
      suggestions: briefing.suggestions,
      adapters: dictation ? { dictation } : {},
    })
  const runtime = useRemoteThreadListRuntime({
    adapter: conversationList,
    runtimeHook: useThreadRuntime,
    threadId: id,
    onThreadIdChange: (stored) => {
      // A thread kept only in this tab has no address of its own.
      if (stored && stored !== id && !unstored.has(stored)) {
        void navigate({
          to: "/app/c/$id",
          params: { id: stored },
          replace: true,
        })
      }
    },
  })

  // "New chat" on /app itself: the address is the same, the state is new.
  const fresh = useLocation({ select: (location) => location.state.chat })
  const seen = useRef(fresh)
  useEffect(() => {
    if (fresh === seen.current) return
    seen.current = fresh
    void runtime.threads.switchToNewThread()
  }, [fresh, runtime])

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* The shell's main scrolls; the thread owns its own scroll instead. */}
      <div className="h-full">
        <Thread
          briefing={briefing.line}
          components={{ ToolFallback: Approval }}
          context={briefing.context}
          mode={mode}
          onModeChange={changeMode}
          placeholder="Ask, or tell me what to change"
          quickActions={OWNER_QUICK_ACTIONS}
        />
      </div>
    </AssistantRuntimeProvider>
  )
}
