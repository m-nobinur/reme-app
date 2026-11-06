import {
  type AssistantState,
  type MessagePrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
  useAui,
  useAuiState,
} from "@assistant-ui/react"
import { PaintBrushIcon } from "@phosphor-icons/react"
import type { AvatarId } from "@workspace/contracts"
import { TraySlotProvider } from "@workspace/ui/components/assistant/question-tray"
import { PillsShownProvider } from "@workspace/ui/components/assistant/reply-pill"
import {
  Composer,
  LatestChoices,
  RecapReplies,
  SkipThisOne,
} from "@workspace/ui/components/assistant/thread-composer"
import {
  EMPTY_COMPONENTS,
  NewSinceContext,
  ThreadComponentsContext,
  ThreadRevealContext,
  ThreadSettingsContext,
} from "@workspace/ui/components/assistant/thread-context"
import {
  DateDivider,
  NewDivider,
} from "@workspace/ui/components/assistant/thread-labels"
import {
  AssistantMessage as DefaultAssistantMessage,
  UserMessage,
} from "@workspace/ui/components/assistant/thread-message"
import { ThreadHistorySkeleton } from "@workspace/ui/components/assistant/thread-pending"
import {
  FollowBottom,
  KeepTurnAnchor,
  ThreadScrollToBottom,
} from "@workspace/ui/components/assistant/thread-scroll"
import { AssistantAvatar } from "@workspace/ui/components/assistant-avatar"
import { ComposerInputContext } from "@workspace/ui/hooks/use-composer-input"
import { cn } from "@workspace/ui/lib/utils"
import {
  type ComponentType,
  type FC,
  type PropsWithChildren,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

export type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart

/**
 * Optional component overrides for the thread. `AssistantMessage` and
 * `Welcome` replace whole sections; the remaining slots override how the
 * assistant message renders tool calls and part groups. Tool UIs registered
 * by name (toolkit `render`, `useAssistantDataUI`) take precedence over
 * `ToolFallback`.
 */
export type ThreadComponents = {
  AssistantMessage?: ComponentType | undefined
  Welcome?: ComponentType | undefined
  ToolFallback?: ToolCallMessagePartComponent | undefined
  ToolGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined
  ReasoningGroup?:
    | ComponentType<PropsWithChildren<{ group: ThreadGroupPart }>>
    | undefined
}

/** A "+" entry: picking it puts `prompt` in the composer for the owner to finish. */
export type ThreadQuickAction = { title: string; prompt: string }

/**
 * What "+" offers the owner: sentences they finish, never a send on their
 * behalf. One list, so the app and the catalog cannot drift apart.
 */
export const OWNER_QUICK_ACTIONS: readonly ThreadQuickAction[] = [
  { title: "Change my website", prompt: "On my website, please change " },
  { title: "Check what needs me", prompt: "What is waiting on me?" },
  { title: "Remind me", prompt: "Remind me to " },
]

/**
 * A mode the composer is in: its icon takes the place of "+", and its
 * placeholder replaces the thread's. `onClear` is that icon's press.
 */
export type ThreadMode = {
  label: string
  icon: ReactNode
  placeholder: string
  onClear: () => void
}

/** Website change mode, which the panel's Request changes turns on. */
export const SITE_CHANGE_MODE: Omit<ThreadMode, "onClear"> = {
  label: "Website change",
  icon: <PaintBrushIcon aria-hidden />,
  placeholder: "Describe what to change on your website…",
}

export type ThreadProps = {
  components?: ThreadComponents | undefined
  /**
   * The id of a stored conversation, at its own address. It is never a new
   * chat: while its history loads it shows a skeleton, never the welcome,
   * and nothing sends until the thread is that conversation.
   * Once loaded and still empty it shows the welcome, like a new chat.
   */
  stored?: string | undefined
  autoFocus?: boolean | undefined
  placeholder?: string | undefined
  /** The composer's placeholder while a question is open in the tray above it. */
  questionPlaceholder?: string | undefined
  /** One line under the welcome heading, built from state rather than a model. */
  briefing?: string | null | undefined
  /** What the owner named their assistant, for "Reme is reading your message". */
  assistant?: string | null | undefined
  quickActions?: readonly ThreadQuickAction[] | undefined
  /** A new mode object focuses the composer, so each press lands there. */
  mode?: ThreadMode | undefined
  /**
   * Drawn after the last message, from app state rather than the thread,
   * such as the card that says a build is ready. Announced when it appears.
   */
  after?: ReactNode
  /** What waits on the owner, under the composer of an empty chat. */
  updates?: ReactNode
  /**
   * Plays the conversation's opening message in the first time it is seen,
   * as a reply being written: the typing dot, then the words, then its
   * cards. `unseen` says whether this browser has shown that message;
   * `seen` records that it now has.
   */
  reveal?: ThreadReveal | undefined
  /**
   * Where this browser left the stored conversation, so a "New" rule sits
   * above the first message it has not shown. Kept as the thread shows more.
   */
  lastShown?: ThreadLastShown | undefined
  /** Sends the owner's last message again, offered on a reply that failed. */
  onRetry?: (() => void) | undefined
  /** In a few words, why dictation did not start or stopped, under the composer's field. */
  dictationNotice?: string | null | undefined
  /** The dictation behind the composer's mic, for its cancel and its level meter. */
  dictation?: ThreadDictation | undefined
  /** The face the owner picked for their assistant, over the welcome; Reme's own without one. */
  avatar?: AvatarId | null | undefined
}

/** What the composer needs of a dictation beyond assistant-ui's adapter. */
export type ThreadDictation = {
  /** Ends the dictation running now, keeping none of its words for later. */
  cancel: () => void
  /** The microphone's level, 0 to 1, as it is captured. */
  onLevel: (listener: (level: number) => void) => () => void
}

export type ThreadReveal = {
  unseen: (messageId: string, createdAt: string | null) => boolean
  seen: (messageId: string) => void
}

/** The id of the last message this browser showed of a conversation, if any. */
export type ThreadLastShown = {
  get: (conversationId: string) => string | null
  set: (conversationId: string, messageId: string) => void
}

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 && (!s.thread.isLoading || s.threads.isLoading)

/**
 * Holds `value` true for `ms` after it turns false. The runtime swaps the
 * placeholder thread for the stored one in two steps, and the loading flags
 * can read false between them for a render; without the hold the skeleton
 * unmounts there and the transcript blinks empty.
 */
const useHeld = (value: boolean, ms: number) => {
  const [held, setHeld] = useState(value)
  useEffect(() => {
    if (value) {
      setHeld(true)
      return
    }
    const timer = setTimeout(() => setHeld(false), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return value || held
}

// Loading until it is the thread on screen with its history in. The runtime
// builds a switched thread off screen and keeps the previous one on screen
// meanwhile, loaded and not loading.
const isStoredLoading = (s: AssistantState, stored: string) =>
  s.thread.isLoading ||
  s.threads.isLoading ||
  s.threadListItem.remoteId !== stored

// Only a stored conversation has history to wait for; a new chat has none.
const HistoryLoading: FC<{ loading: boolean }> = ({ loading }) => {
  const empty = useAuiState((s) => s.thread.messages.length === 0)
  return empty && loading ? <ThreadHistorySkeleton /> : null
}

export const Thread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  autoFocus = true,
  stored,
  placeholder,
  questionPlaceholder,
  briefing,
  quickActions,
  mode,
  assistant,
  onRetry,
  dictationNotice,
  dictation,
  avatar,
  after,
  updates,
  reveal,
  lastShown,
}) => {
  // A stored conversation with nothing in it is as empty as a new chat, once
  // its history is in: the same welcome, with the composer in
  // the middle. Until then it is loading, and the held flag keeps the render
  // in between from showing the welcome.
  const loadingStored = useAuiState((s) =>
    stored ? isStoredLoading(s, stored) : false
  )
  const holdStored = useHeld(loadingStored, 300)
  // The stored conversation the address just left. A new chat's address
  // comes first and the runtime's switch to it a render or more later, so
  // until then the thread on screen is still that conversation.
  const [address, setAddress] = useState({ stored, left: stored })
  if (address.stored !== stored) setAddress({ stored, left: address.stored })
  const left = address.left
  const leaving = useAuiState(
    (s) => !stored && left !== undefined && s.threadListItem.remoteId === left
  )
  const isEmpty = useAuiState((s) =>
    stored
      ? !holdStored && s.thread.messages.length === 0
      : leaving || isNewChatView(s)
  )
  const settings = useMemo(
    () => ({
      stored,
      placeholder,
      questionPlaceholder,
      briefing,
      quickActions,
      mode,
      assistant,
      onRetry,
      dictationNotice,
      dictation,
      avatar,
    }),
    [
      stored,
      placeholder,
      questionPlaceholder,
      briefing,
      quickActions,
      mode,
      assistant,
      onRetry,
      dictationNotice,
      dictation,
      avatar,
    ]
  )
  // Held by its parts, so a caller's inline object does not redraw every
  // message on each of its renders, such as each workspace poll.
  const {
    AssistantMessage,
    Welcome,
    ToolFallback: Fallback,
    ToolGroup,
    ReasoningGroup,
  } = components
  const parts = useMemo(
    () => ({
      AssistantMessage,
      Welcome,
      ToolFallback: Fallback,
      ToolGroup,
      ReasoningGroup,
    }),
    [AssistantMessage, Welcome, Fallback, ToolGroup, ReasoningGroup]
  )
  // The composer's input, which a card can hand the owner to.
  const input = useRef<HTMLTextAreaElement>(null)
  const newSince = useNewSince(stored, lastShown)

  return (
    <ThreadComponentsContext.Provider value={parts}>
      <ThreadSettingsContext.Provider value={settings}>
        <ThreadRevealContext.Provider value={reveal}>
          <NewSinceContext.Provider value={newSince}>
            <ComposerInputContext.Provider value={input}>
              <ThreadRoot
                after={after}
                autoFocus={autoFocus}
                isEmpty={isEmpty}
                leaving={leaving}
                loading={Boolean(stored) && holdStored}
                updates={updates}
              />
            </ComposerInputContext.Provider>
          </NewSinceContext.Provider>
        </ThreadRevealContext.Provider>
      </ThreadSettingsContext.Provider>
    </ThreadComponentsContext.Provider>
  )
}

/**
 * The first message of `stored` this browser had not shown when its history
 * came in, or null: none new, or no mark to go by. Read once per
 * conversation, so the rule stays put while it is open; then each message
 * the thread shows moves the mark, so a message sent here is never new, and
 * the next visit has none until something lands.
 */
const useNewSince = (
  stored: string | undefined,
  lastShown: ThreadLastShown | undefined
) => {
  const aui = useAui()
  const ready = useAuiState(
    (s) =>
      Boolean(stored && lastShown) &&
      s.threadListItem.remoteId === stored &&
      !s.thread.isLoading &&
      s.thread.messages.length > 0
  )
  const last = useAuiState((s) => (ready ? s.thread.messages.at(-1)?.id : null))
  const since = useRef<{ stored: string; id: string | null } | null>(null)
  if (ready && stored && lastShown && since.current?.stored !== stored) {
    const ids = aui
      .thread()
      .getState()
      .messages.map((message) => message.id)
    const mark = lastShown.get(stored)
    const at = mark === null ? -1 : ids.indexOf(mark)
    since.current = { stored, id: at === -1 ? null : (ids[at + 1] ?? null) }
  }
  useEffect(() => {
    if (stored && last) lastShown?.set(stored, last)
  }, [stored, last, lastShown])
  const read = since.current
  return read && read.stored === stored ? read.id : null
}

const ThreadRoot: FC<{
  isEmpty: boolean
  leaving: boolean
  loading: boolean
  autoFocus: boolean
  after: ReactNode
  updates: ReactNode
}> = ({ isEmpty, leaving, loading, autoFocus, after, updates }) => {
  const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext)
  // Where the question tray docks, above the composer; each question's call
  // sits in the transcript and draws itself here.
  const [tray, setTray] = useState<HTMLElement | null>(null)
  const [footer, setFooter] = useState<HTMLElement | null>(null)
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const [spacer, setSpacer] = useState<HTMLElement | null>(null)
  const [unseen, setUnseen] = useState(false)
  const [below, setBelow] = useState(false)
  const [rows, setRows] = useState(0)
  const pills = useMemo(() => ({ rows, set: setRows }), [rows])

  return (
    <PillsShownProvider value={pills}>
      <TraySlotProvider value={tray}>
        <ThreadPrimitive.Root
          className="aui-root aui-thread-root @container flex h-full flex-col bg-background"
          style={{
            ["--thread-max-width" as string]: "44rem",
            ["--composer-bg" as string]: "var(--color-card)",
            ["--composer-radius" as string]: "var(--radius-2xl)",
            ["--composer-padding" as string]: "8px",
          }}
        >
          <ThreadPrimitive.Viewport
            // A message of eight lines, and a longer one folded to six, show
            // whole at the top: the library's 10em would keep only the last
            // lines of either. The visible height stays its default.
            topAnchorMessageClamp={{ tallerThan: "20rem" }}
            turnAnchor="top"
            data-slot="aui_thread-viewport"
            // Clear of the workspace's floating panel, where there is one; the
            // padding sits inside the scroller, so its bar stays at the edge.
            // No scroll-smooth: it turned the jump to the end of a reopened
            // chat into a glide from the top. Scrolls that glide ask for it.
            className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll pe-(--panel-inset)"
          >
            <KeepTurnAnchor />
            <FollowBottom
              after={slot}
              footer={footer}
              spacer={spacer}
              onBelow={setBelow}
              onUnseen={setUnseen}
            />
            {/* assistant-ui watches the viewport's children. Holding the space
              under a reply (FollowBottom) resizes the box that holds the
              whole transcript, inside that observer's round, and the browser
              logs a ResizeObserver loop. A box with no layout never changes
              size, so the one that does is not watched. */}
            <div className="contents">
              <div
                className={cn(
                  "mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4",
                  isEmpty && "justify-center"
                )}
              >
                {isEmpty ? (
                  <Welcome />
                ) : (
                  // The welcome carries the page's heading; a conversation has
                  // its title in the top bar, and this names the page for a
                  // screen reader.
                  <h1 className="sr-only">Conversation</h1>
                )}
                <HistoryLoading loading={loading} />

                {/* The space assistant-ui holds below a pinned reply goes last,
                after the slot. An empty slot's margin takes back its gap. A
                conversation keeps room under its last row for the Scroll to
                bottom button, which floats over the thread above the
                composer. */}
                <div
                  data-slot="aui_message-group"
                  className={cn(
                    "flex flex-col gap-y-6 has-[>:not(:empty)]:mb-14 [&>[data-aui-top-anchor-reserve]]:order-last",
                    !isEmpty && "mb-14"
                  )}
                >
                  {leaving ? null : <ThreadMessages />}
                  {/* Always in the page, so a card that appears in it is read out. */}
                  <div aria-live="polite" className="empty:-mt-6" ref={setSlot}>
                    {leaving ? null : after}
                  </div>
                </div>
                <div
                  aria-hidden
                  className="pointer-events-none shrink-0"
                  data-slot="aui_thread-spacer"
                  ref={setSpacer}
                />

                <ThreadPrimitive.ViewportFooter
                  ref={setFooter}
                  className={cn(
                    "aui-thread-viewport-footer flex flex-col gap-4 overflow-visible bg-background pb-4 md:pb-6",
                    !isEmpty &&
                      "sticky bottom-0 mt-auto rounded-t-(--composer-radius)"
                  )}
                >
                  <ThreadScrollToBottom below={below} unseen={unseen} />
                  <div className="flex flex-col gap-2">
                    {leaving ? null : (
                      <>
                        <SkipThisOne />
                        <RecapReplies />
                        <LatestChoices />
                      </>
                    )}
                    {/* A stack that slid away leaves no gap behind it. */}
                    <div
                      className="empty:hidden has-[>[data-slot=update-stack][data-away]]:-mb-2 motion-safe:transition-[margin] motion-safe:duration-enter motion-safe:ease-standard"
                      ref={setTray}
                    />
                    <Composer autoFocus={autoFocus} expanded={isEmpty} />
                    {/* The same gap as the tray above the composer. */}
                    {isEmpty ? updates : null}
                  </div>
                </ThreadPrimitive.ViewportFooter>
              </div>
            </div>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </TraySlotProvider>
    </PillsShownProvider>
  )
}

const ThreadMessage: FC = () => {
  const {
    AssistantMessage: AssistantMessageComponent = DefaultAssistantMessage,
  } = useContext(ThreadComponentsContext)
  const role = useAuiState((s) => s.message.role)
  const first = useAuiState((s) => s.message.id) === useContext(NewSinceContext)

  return (
    <>
      <DateDivider />
      {first ? <NewDivider /> : null}
      {role === "user" ? <UserMessage /> : <AssistantMessageComponent />}
    </>
  )
}

// Module level, so each row keeps its memo when the thread re-renders.
const MESSAGE_COMPONENTS = { Message: ThreadMessage }

/**
 * Each row's key, space separated: a reply's is the message before it, not
 * its own id. While a turn waits the runtime shows a placeholder reply under
 * an id of its own, and the reply that streams in carries the server's, so
 * keyed by id the row was torn down and mounted again on every reply.
 */
export const rowKeys = (messages: readonly { id: string; role: string }[]) =>
  messages
    .map((message, index) =>
      message.role === "assistant"
        ? `reply:${messages[index - 1]?.id ?? ""}`
        : message.id
    )
    .join(" ")

const ThreadMessages: FC = () => {
  const keys = useAuiState((s) => rowKeys(s.thread.messages))
  if (!keys) return null
  return keys
    .split(" ")
    .map((key, index) => (
      <ThreadPrimitive.MessageByIndex
        components={MESSAGE_COMPONENTS}
        index={index}
        key={key}
      />
    ))
}

// No entrance motion: the page loads into the task, not into a show.
const ThreadWelcome: FC = () => {
  const { briefing, avatar } = useContext(ThreadSettingsContext)
  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col items-center px-4 text-center">
      <AssistantAvatar className="mb-4 size-14" id={avatar ?? null} />
      <h1 className="aui-thread-welcome-message-inner font-semibold text-[1.75rem] leading-tight tracking-tight">
        What should we do today?
      </h1>
      {briefing ? (
        <p
          data-slot="aui_thread-briefing"
          className="mt-2 max-w-prose text-base text-muted-foreground"
        >
          {briefing}
        </p>
      ) : null}
    </div>
  )
}
