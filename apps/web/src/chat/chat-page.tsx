import {
  AssistantRuntimeProvider,
  AuiConfig,
  Tools,
  useAuiState,
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
import type { ChatRequest } from "@workspace/contracts"
import { Approval } from "@workspace/ui/components/assistant/approval"
import { BuildQuestionsUI } from "@workspace/ui/components/assistant/build-questions"
import { ChangeAskedUI } from "@workspace/ui/components/assistant/change-asked"
import { makeEnquiryCardUI } from "@workspace/ui/components/assistant/enquiry-card"
import { MemoryChipUI } from "@workspace/ui/components/assistant/memory-chip"
import { PersonaCardUI } from "@workspace/ui/components/assistant/persona-card"
import { ServerButtonUI } from "@workspace/ui/components/assistant/server-button"
import {
  OWNER_QUICK_ACTIONS,
  SITE_CHANGE_MODE,
  Thread,
} from "@workspace/ui/components/assistant/thread"
import { ownerToolkit } from "@workspace/ui/components/assistant/toolkit"
import { buttonVariants } from "@workspace/ui/components/button"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { ChatServicesProvider } from "@workspace/ui/lib/chat-services"
import {
  type PropsWithChildren,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import { deleteReminder } from "@/lib/api/server"
import { assistantOf, briefingOf } from "@/lib/briefing"
import { LAST_SHOWN, OPENING_REVEAL } from "@/lib/reveal"
import { useLiveWorkspace } from "@/lib/workspace"
import { answerBuildQuestion } from "./build-questions"
import { BuildStopped } from "./build-stopped"
import {
  conversationList,
  MissingConversation,
  seedOpening,
  unstored,
} from "./conversations"
import { cosTools, liveKey, liveState, questionTitles } from "./cos-tools"
import { saveDesignAnswer } from "./design"
import { dictation } from "./dictation"
import { DictationTidy } from "./dictation-tidy"
import { domainPurchase } from "./domain-purchase"
import { askedSend, startsNewChat, tailOf } from "./history"
import { useConversationRuntime } from "./runtime"
import { SendAsked } from "./send-asked"
import { StillWorking } from "./still-working"
import { trayServices } from "./tray-services"
import { alwaysTapped } from "./turn"
import { ChatUpdates, ConversationUpdates } from "./updates"
import { uploadPhotos } from "./upload"

const frame = getRouteApi("/app")

const EnquiryCardUI = makeEnquiryCardUI(trayServices.imageUrl)

/** The Request changes presses the composer has taken, by their key. */
const composed = new Set<string>()

const tapAlways = (approvalId: string) => {
  alwaysTapped.add(approvalId)
}

const config = AuiConfig({ tools: Tools({ toolkit: ownerToolkit }) })

/**
 * The conversation at `/app` (a new one) and `/app/c/$id` (a stored one).
 * The address is the thread: the runtime follows `id`, and when a new
 * chat's first send stores it, the address follows the stored id.
 */
export function ChatPage() {
  const navigate = useNavigate()
  const { id } = useParams({ strict: false })
  const router = useRouter()
  const { active, conversations, opening } = frame.useLoaderData()
  seedOpening(opening)
  // Onboarding's opening message plays in, the first time it is seen.
  const onboarding = conversations?.some(
    (each) => each.id === id && each.kind === "onboarding"
  )
  // The polled workspace, not the loader's: a build that goes live after the
  // turn ends would otherwise leave the line above the composer a version
  // behind the panel until a reload.
  const live = useLiveWorkspace()
  // The panel's "Your logo" row follows a round the tray starts or settles
  // at once, not on the next idle poll, which a 35 s round can slip between.
  const services = useMemo(
    () => ({
      ...trayServices,
      drawLogos: (request: Parameters<typeof trayServices.drawLogos>[0]) =>
        trayServices.drawLogos(request).then((round) => {
          void live.refresh()
          return round
        }),
      keepLogo: (logo: string) =>
        trayServices.keepLogo(logo).then((kept) => {
          void live.refresh()
          return kept
        }),
    }),
    [live.refresh]
  )
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
  const intent = useRef<ChatRequest["intent"]>(undefined)
  const retry = useRef<(() => void) | null>(null)
  // A button's intent stays until its send takes it; the mode follows the chip.
  if (siteChange) intent.current = "site_change"
  else if (intent.current === "site_change") intent.current = undefined
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
      intent,
      retry,
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
  const askIntent = useLocation({
    select: (location) => location.state.intent,
  })
  const seen = useRef(fresh)
  useEffect(() => {
    const press = startsNewChat(seen.current, fresh)
    seen.current = fresh
    const send = askedSend({ id, ask, fresh, intent: askIntent })
    void (async () => {
      if (press) await runtime.threads.switchToNewThread()
      if (send) {
        intent.current = send.intent
        runtime.thread.append(send.text)
      }
    })()
  }, [id, fresh, ask, askIntent, runtime])

  // The cards name the question an answer goes to, and times in the
  // business's zone, and offer only what is still to do: no sign-in once
  // connected, no undo for a reminder gone. Keyed on strings, so a poll that
  // changes none of them redraws no card.
  const titles = questionTitles(live.workspace?.attention)
  const zone = live.workspace?.timeZone ?? null
  const key = liveKey(live.workspace)
  const shared = useMemo(() => {
    const { cards, reminderOpen } = liveState(key)
    return {
      cosTools: {
        ...cosTools(titles, zone),
        removeReminder: (reminder: string) =>
          deleteReminder({ data: { id: reminder } }),
        ...(reminderOpen && { reminderOpen }),
      },
      liveCards: cards,
      alwaysAllow: tapAlways,
      uploadPhotos,
      tray: services,
      saveDesignAnswer,
      domainPurchase,
      answerBuildQuestion,
    }
  }, [titles, zone, key, services])

  const assistant = assistantOf(live.workspace)
  const dictationNotice = useSyncExternalStore(
    dictation.notice.subscribe,
    dictation.notice.read,
    () => null
  )

  return (
    <AssistantRuntimeProvider config={config} runtime={runtime}>
      <ServerButtonUI />
      <DictationTidy />
      <ChangeAskedUI />
      <BuildQuestionsUI />
      <MemoryChipUI />
      <PersonaCardUI />
      <EnquiryCardUI />
      <SendAsked conversation={id} intent={intent} />
      {/* The shell's main scrolls; the thread owns its own scroll instead. */}
      <div className="h-full">
        <Opens
          id={id}
          gone={
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
          }
        >
          <ChatServicesProvider value={shared}>
            <Thread
              after={
                <>
                  <StillWorking />
                  <ConversationUpdates />
                  <BuildStopped />
                </>
              }
              assistant={live.workspace?.assistantName}
              avatar={live.workspace?.assistantAvatar ?? null}
              briefing={briefing.line}
              components={{ ToolFallback: Approval }}
              dictation={dictation}
              dictationNotice={dictationNotice}
              lastShown={LAST_SHOWN}
              mode={mode}
              onRetry={() => retry.current?.()}
              // One neutral line: rotating ideas offered work the
              // owner could not ask for yet.
              placeholder={`Message ${assistant}…`}
              questionPlaceholder={`Tell ${assistant} what to do instead…`}
              quickActions={OWNER_QUICK_ACTIONS}
              reveal={onboarding ? OPENING_REVEAL : undefined}
              stored={id}
              updates={<ChatUpdates />}
            />
          </ChatServicesProvider>
        </Opens>
      </div>
    </AssistantRuntimeProvider>
  )
}

/** The chat, or `gone` when the address names a conversation the owner cannot open. */
function Opens({
  id,
  gone,
  children,
}: PropsWithChildren<{ id: string | undefined; gone: ReactNode }>) {
  const missing = useAuiState((s) => {
    const failed = s.threads.switchError
    return (
      failed !== undefined &&
      failed.threadId === id &&
      failed.error instanceof MissingConversation
    )
  })
  return missing ? gone : children
}
