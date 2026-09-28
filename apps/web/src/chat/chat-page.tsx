import {
  AssistantRuntimeProvider,
  useRemoteThreadListRuntime,
  WebSpeechDictationAdapter,
} from "@assistant-ui/react"
import { ChatsCircleIcon } from "@phosphor-icons/react"
import {
  getRouteApi,
  Link,
  useLocation,
  useNavigate,
  useParams,
  useRouter,
} from "@tanstack/react-router"
import { Approval } from "@workspace/ui/components/assistant/approval"
import { CosToolsProvider } from "@workspace/ui/components/assistant/cos-tools"
import {
  OWNER_QUICK_ACTIONS,
  Thread,
  type ThreadMode,
} from "@workspace/ui/components/assistant/thread"
import { buttonVariants } from "@workspace/ui/components/button"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { browserZone } from "@workspace/ui/lib/zone"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { briefingOf } from "@/lib/briefing"
import { useLiveWorkspace } from "@/lib/workspace"
import { conversationList, unstored } from "./conversations"
import { missingConversations, startsNewChat } from "./history"
import { useConversationRuntime } from "./runtime"

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
  const router = useRouter()
  const { active, workspace } = frame.useLoaderData()
  const live = useLiveWorkspace()
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
  // Read at send time, so a mode picked after the thread opened still goes.
  const modeNow = useRef(mode)
  modeNow.current = mode
  const useThreadRuntime = () =>
    useConversationRuntime({
      mode: () => modeNow.current,
      // A turn can change what waits on the owner and the conversation's
      // title, so the frame reads both again: the panel adopts the new
      // workspace and the rail the new list.
      onFinish: () => {
        void router.invalidate()
      },
      // The option, not `adapters.suggestion`: in @assistant-ui/ai-sdk 0.0.2
      // the adapter runs only after an assistant turn ends and then replaces
      // these, and the empty thread is the only place suggestions show.
      // A stored conversation never offers them: one pressed while its
      // history loaded started a second conversation.
      suggestions: id ? [] : briefing.suggestions,
      dictation,
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
    const press = startsNewChat(seen.current, fresh)
    seen.current = fresh
    if (press) void runtime.threads.switchToNewThread()
  }, [fresh, runtime])

  const missing = useSyncExternalStore(
    missingConversations.subscribe,
    () => (id ? missingConversations.has(id) : false),
    () => false
  )

  // The cards name the question an answer goes to, from the workspace the
  // panel already reads, and times in the zone each turn carries.
  const questions = live.workspace?.attention
  const tools = useMemo(
    () => ({
      zone: browserZone(),
      question: (requestId: string) =>
        questions?.find(
          (item) => item.kind === "question" && item.id === requestId
        )?.title ?? null,
    }),
    [questions]
  )

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {/* The shell's main scrolls; the thread owns its own scroll instead. */}
      <div className="h-full">
        {missing ? (
          <div className="mx-auto max-w-xl px-4 pt-16">
            <EmptyState
              action={
                <Link
                  className={buttonVariants({ variant: "outline" })}
                  state={() => ({ chat: crypto.randomUUID() })}
                  to="/app"
                >
                  Start a new chat
                </Link>
              }
              description="It belongs to another account, or the link is wrong."
              icon={<ChatsCircleIcon />}
              title="This conversation is not here"
            />
          </div>
        ) : (
          <CosToolsProvider value={tools}>
            <Thread
              briefing={briefing.line}
              components={{ ToolFallback: Approval }}
              context={briefing.context}
              mode={mode}
              onModeChange={changeMode}
              placeholder="Ask, or tell me what to change"
              quickActions={OWNER_QUICK_ACTIONS}
              stored={Boolean(id)}
            />
          </CosToolsProvider>
        )}
      </div>
    </AssistantRuntimeProvider>
  )
}
