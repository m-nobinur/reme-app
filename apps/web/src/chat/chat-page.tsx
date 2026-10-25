import {
  AssistantRuntimeProvider,
  useRemoteThreadListRuntime,
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
import { SaveDesignAnswerProvider } from "@workspace/ui/components/assistant/ask-design"
import { UploadPhotosProvider } from "@workspace/ui/components/assistant/ask-upload"
import {
  AnswerBuildQuestionProvider,
  BuildQuestionsUI,
} from "@workspace/ui/components/assistant/build-questions"
import { DomainPurchaseProvider } from "@workspace/ui/components/assistant/buy-domain"
import { ChangeAskedUI } from "@workspace/ui/components/assistant/change-asked"
import { CosToolsProvider } from "@workspace/ui/components/assistant/cos-tools"
import { MemoryChipUI } from "@workspace/ui/components/assistant/memory-chip"
import { ServerButtonUI } from "@workspace/ui/components/assistant/server-button"
import {
  OWNER_QUICK_ACTIONS,
  SITE_CHANGE_MODE,
  Thread,
} from "@workspace/ui/components/assistant/thread"
import { TrayServicesProvider } from "@workspace/ui/components/assistant/tray-services"
import { buttonVariants } from "@workspace/ui/components/button"
import { EmptyState } from "@workspace/ui/components/empty-state"
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { assistantOf, briefingOf } from "@/lib/briefing"
import { OPENING_REVEAL } from "@/lib/reveal"
import { useLiveWorkspace } from "@/lib/workspace"
import { answerBuildQuestion } from "./build-questions"
import { BuildStopped } from "./build-stopped"
import { conversationList, unstored } from "./conversations"
import { cosTools, questionTitles } from "./cos-tools"
import { saveDesignAnswer } from "./design"
import { domainPurchase } from "./domain-purchase"
import { asked, missingConversations, startsNewChat, tailOf } from "./history"
import { useConversationRuntime } from "./runtime"
import { ChatSiteReadyCard } from "./site-ready"
import { StillWorking } from "./still-working"
import { trayServices } from "./tray-services"
import { ChatUpdates } from "./updates"
import { uploadPhotos } from "./upload"

const frame = getRouteApi("/app")

/** The Request changes presses the composer has taken, by their key. */
const composed = new Set<string>()

/**
 * The conversation at `/app` (a new one) and `/app/c/$id` (a stored one).
 * The address is the thread: the runtime follows `id`, and when a new
 * chat's first send stores it, the address follows the stored id.
 */
export function ChatPage() {
  const navigate = useNavigate()
  const { id } = useParams({ strict: false })
  const router = useRouter()
  const { active, conversations } = frame.useLoaderData()
  // Onboarding's opening message plays in, the first time it is seen.
  const onboarding = conversations?.some(
    (each) => each.id === id && each.kind === "onboarding"
  )
  // The polled workspace, not the loader's: a build that goes live after the
  // turn ends would otherwise leave the line above the composer a version
  // behind the panel until a reload.
  const live = useLiveWorkspace()
  const briefing = useMemo(
    () => briefingOf(active, live.workspace),
    [active, live.workspace]
  )
  // Request changes on the panel puts the composer in website change mode,
  // once per press, so going back to it does not turn the mode on again. The
  // owner's next send carries it and ends it, and so does the chip's ×.
  const compose = useLocation({ select: (location) => location.state.compose })
  const [siteChange, setSiteChange] = useState<string | null>(null)
  useEffect(() => {
    if (!compose || composed.has(compose.key)) return
    composed.add(compose.key)
    setSiteChange(compose.key)
  }, [compose])
  // A new object per press, so the composer takes focus on each one.
  const mode = useMemo(
    () =>
      siteChange
        ? { ...SITE_CHANGE_MODE, onClear: () => setSiteChange(null) }
        : undefined,
    [siteChange]
  )
  const intent = useRef<"site_change" | undefined>(undefined)
  intent.current = siteChange ? "site_change" : undefined
  // A message the assistant posted on its own, named by the polled tag. Set
  // here, where the workspace re-renders, for the runtime hook to follow.
  const tail = useRef<{ current: string | null; moved?: () => void }>({
    current: null,
  }).current
  const liveTail = tailOf(live.workspace?.etag)
  tail.current = liveTail
  useEffect(() => {
    if (liveTail) tail.moved?.()
  }, [liveTail, tail])
  const useThreadRuntime = () =>
    useConversationRuntime({
      // A turn can change what waits on the owner and the conversation's
      // title, so the frame reads both again: the panel adopts the new
      // workspace and the rail the new list.
      onFinish: () => {
        void router.invalidate()
      },
      // The option, not `adapters.suggestion`: in @assistant-ui/ai-sdk 0.0.2
      // the adapter runs only after an assistant turn ends and then replaces
      // these, and the empty thread is the only place suggestions show.
      // A stored conversation shows them only when it is empty, and the thread
      // calls it empty only once its history is in: one pressed while it
      // loaded started a second conversation.
      suggestions: briefing.suggestions,
      intent,
      onIntentSent: () => setSiteChange(null),
      tail,
      refresh: live.refresh,
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
  // A press that carries a question sends it as the chat's first message,
  // once per press, so going back to it does not ask again. Never on a stored
  // conversation, whose thread is a placeholder until its history is in.
  const fresh = useLocation({ select: (location) => location.state.chat })
  const ask = useLocation({ select: (location) => location.state.ask })
  const seen = useRef(fresh)
  useEffect(() => {
    const press = startsNewChat(seen.current, fresh)
    seen.current = fresh
    const send = !id && ask && fresh && !asked.has(fresh) ? ask : undefined
    if (send && fresh) asked.add(fresh)
    void (async () => {
      if (press) await runtime.threads.switchToNewThread()
      if (send) runtime.thread.append(send)
    })()
  }, [id, fresh, ask, runtime])

  const missing = useSyncExternalStore(
    missingConversations.subscribe,
    () => (id ? missingConversations.has(id) : false),
    () => false
  )

  // The cards name the question an answer goes to, and times in the zone each
  // turn carries. Keyed on the titles, so a poll that changes neither redraws
  // no card.
  const titles = questionTitles(live.workspace?.attention)
  const tools = useMemo(() => cosTools(titles), [titles])

  const assistant = assistantOf(live.workspace)
  const ideas = useMemo(
    () => [
      `Ask ${assistant} to draft a quote…`,
      `Ask ${assistant} to follow up with a customer…`,
      `Tell ${assistant} about a new service…`,
    ],
    [assistant]
  )

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ServerButtonUI />
      <ChangeAskedUI />
      <BuildQuestionsUI />
      <MemoryChipUI />
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
            <UploadPhotosProvider value={uploadPhotos}>
              <TrayServicesProvider value={trayServices}>
                <SaveDesignAnswerProvider value={saveDesignAnswer}>
                  <DomainPurchaseProvider value={domainPurchase}>
                    <AnswerBuildQuestionProvider value={answerBuildQuestion}>
                      <Thread
                        after={
                          <>
                            <StillWorking />
                            <ChatSiteReadyCard />
                            <BuildStopped />
                          </>
                        }
                        assistant={live.workspace?.assistantName}
                        briefing={briefing.line}
                        components={{ ToolFallback: Approval }}
                        mode={mode}
                        placeholder={`Ask ${assistant} anything…`}
                        placeholderIdeas={ideas}
                        questionPlaceholder={`Tell ${assistant} what to do instead…`}
                        quickActions={OWNER_QUICK_ACTIONS}
                        reveal={onboarding ? OPENING_REVEAL : undefined}
                        stored={id}
                        updates={<ChatUpdates />}
                      />
                    </AnswerBuildQuestionProvider>
                  </DomainPurchaseProvider>
                </SaveDesignAnswerProvider>
              </TrayServicesProvider>
            </UploadPhotosProvider>
          </CosToolsProvider>
        )}
      </div>
    </AssistantRuntimeProvider>
  )
}
