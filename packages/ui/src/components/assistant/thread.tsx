import {
  ActionBarPrimitive,
  type AssistantState,
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  type GroupByContext,
  groupPartByType,
  type ThreadMessage as MessageData,
  MessagePartPrimitive,
  MessagePrimitive,
  type PartState,
  SuggestionPrimitive,
  TextMessagePartProvider,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
  useAui,
  useAuiState,
  useThreadViewportStore,
} from "@assistant-ui/react"
import {
  ArrowBendDownRightIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  ChecksIcon,
  PaintBrushIcon,
  PlusIcon,
  SquareIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  XIcon,
} from "@phosphor-icons/react"
import { SKIP_REPLY } from "@workspace/contracts"
import { OWNER_CARDS } from "@workspace/ui/components/assistant/approval"
import { waitsToSkip } from "@workspace/ui/components/assistant/ask-open"
import { COS_QUIET } from "@workspace/ui/components/assistant/cos-tools"
import { MarkdownText } from "@workspace/ui/components/assistant/markdown-text"
import { TraySlotProvider } from "@workspace/ui/components/assistant/question-tray"
import {
  ReasoningGroup as DefaultReasoningGroup,
  Reasoning,
} from "@workspace/ui/components/assistant/reasoning"
import { ThreadHistorySkeleton } from "@workspace/ui/components/assistant/thread-pending"
import { ToolFallback } from "@workspace/ui/components/assistant/tool-fallback"
import { ToolGroup as DefaultToolGroup } from "@workspace/ui/components/assistant/tool-group"
import { TooltipIconButton } from "@workspace/ui/components/assistant/tooltip-icon-button"
import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { LogoMark } from "@workspace/ui/components/logo"
import { StatusLine } from "@workspace/ui/components/status-line"
import { ComposerInputContext } from "@workspace/ui/hooks/use-composer-input"
import { useCycle } from "@workspace/ui/hooks/use-cycle"
import { useOnboardingStatus } from "@workspace/ui/hooks/use-onboarding-status"
import {
  onboardingKind,
  onboardingLine,
  STILL_ON_IT_AFTER,
  THINKING_AFTER,
  turnKind,
  turnMoment,
  writingBack,
} from "@workspace/ui/lib/activity-copy"
import { SHOW_DELAY_MS } from "@workspace/ui/lib/status-line"
import {
  SESSION_ENDED,
  SKIPPED,
  showsProgress,
  waitsOnTray,
} from "@workspace/ui/lib/tool-state"
import { cn } from "@workspace/ui/lib/utils"
import { localMidnight } from "@workspace/ui/lib/zone"
import {
  type ComponentType,
  createContext,
  type FC,
  type PropsWithChildren,
  type ReactNode,
  type RefObject,
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
   * chat: while its history loads it shows a skeleton, never the welcome or
   * suggestions, and nothing sends until the thread is that conversation.
   * Once loaded and still empty it shows the welcome, like a new chat.
   */
  stored?: string | undefined
  autoFocus?: boolean | undefined
  placeholder?: string | undefined
  /** Other things to ask, which the placeholder rotates through after `placeholder`. */
  placeholderIdeas?: readonly string[] | undefined
  /** The composer's placeholder while a question is open in the tray above it. */
  questionPlaceholder?: string | undefined
  /** One line under the welcome heading, built from state rather than a model. */
  briefing?: string | null | undefined
  /** What the owner named their assistant, for "Ellie is reading your message". */
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
}

export type ThreadReveal = {
  unseen: (messageId: string, createdAt: string | null) => boolean
  seen: (messageId: string) => void
}

type ThreadSettings = Omit<
  ThreadProps,
  "components" | "autoFocus" | "after" | "updates" | "reveal"
>

const EMPTY_COMPONENTS: ThreadComponents = {}
const EMPTY_SETTINGS: ThreadSettings = {}

const UNGROUPED = [] as const

const groupByType = groupPartByType({
  reasoning: ["group-chainOfThought", "group-reasoning"],
  "tool-call": ["group-chainOfThought", "group-tool"],
  "standalone-tool-call": [],
})

/**
 * Where each part sits in the transcript. Everything follows the registry's
 * grouping except a tool call that carries an approval or has a card of its
 * own, which stays ungrouped for the whole of its life: an approval folded
 * into a collapsed disclosure is one the owner has to go looking for, and the
 * answer has to stay as visible as the question was.
 */
const groupThreadParts = (part: PartState, context?: GroupByContext) =>
  part.type === "tool-call" &&
  (part.approval != null ||
    part.status?.type === "requires-action" ||
    Object.hasOwn(OWNER_CARDS, part.toolName) ||
    Object.hasOwn(COS_QUIET, part.toolName))
    ? UNGROUPED
    : groupByType(part, context)

const ThreadComponentsContext =
  createContext<ThreadComponents>(EMPTY_COMPONENTS)
const ThreadSettingsContext = createContext<ThreadSettings>(EMPTY_SETTINGS)
// Apart from the settings, which every message would otherwise re-render on:
// a new mode or briefing then redrew the whole transcript.
const ThreadRevealContext = createContext<ThreadReveal | undefined>(undefined)

// Startup exposes a loading placeholder thread; treat it as a new chat so
// the composer mounts centered. Loads after startup keep the docked layout.
const isNewChatView = (s: AssistantState) =>
  s.thread.messages.length === 0 && (!s.thread.isLoading || s.threads.isLoading)

// A switched thread that is still fetching its history: skeleton, not welcome.
const isHistoryLoadingView = (s: AssistantState) =>
  s.thread.messages.length === 0 &&
  s.thread.isLoading &&
  !s.thread.isDisabled &&
  !s.threads.isLoading

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

/**
 * Whether the composer can send. A stored conversation opens on a placeholder
 * thread and swaps to the stored one once it is fetched; a send before then
 * went to the placeholder and started a second conversation. So nothing sends
 * until the main thread is the stored conversation and its history is in.
 * The thread's id decides, not the loading flags alone: the placeholder's
 * read false.
 */
const useSendable = () => {
  const { stored } = useContext(ThreadSettingsContext)
  return useAuiState(
    (s) =>
      !stored || (s.threadListItem.remoteId === stored && !s.thread.isLoading)
  )
}

const HistoryLoading: FC<{ stored: boolean }> = ({ stored }) => {
  const empty = useAuiState((s) => s.thread.messages.length === 0)
  const loading = useAuiState((s) =>
    stored ? s.thread.isLoading || s.threads.isLoading : isHistoryLoadingView(s)
  )
  const held = useHeld(loading, 300)
  return empty && held ? <ThreadHistorySkeleton /> : null
}

export const Thread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  autoFocus = true,
  stored,
  placeholder,
  placeholderIdeas,
  questionPlaceholder,
  briefing,
  quickActions,
  mode,
  after,
  updates,
  reveal,
}) => {
  // A stored conversation with nothing in it is as empty as a new chat, once
  // its history is in: the same welcome and suggestions, with the composer in
  // the middle. Until then it is loading, and the held flag keeps the render
  // in between from showing the welcome.
  const loadingStored = useAuiState((s) =>
    stored
      ? s.thread.isLoading ||
        s.threads.isLoading ||
        s.threadListItem.remoteId !== stored
      : false
  )
  const holdStored = useHeld(loadingStored, 300)
  const isEmpty = useAuiState((s) =>
    stored ? !holdStored && s.thread.messages.length === 0 : isNewChatView(s)
  )
  const settings = useMemo(
    () => ({
      stored,
      placeholder,
      placeholderIdeas,
      questionPlaceholder,
      briefing,
      quickActions,
      mode,
    }),
    [
      stored,
      placeholder,
      placeholderIdeas,
      questionPlaceholder,
      briefing,
      quickActions,
      mode,
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

  return (
    <ThreadComponentsContext.Provider value={parts}>
      <ThreadSettingsContext.Provider value={settings}>
        <ThreadRevealContext.Provider value={reveal}>
          <ComposerInputContext.Provider value={input}>
            <ThreadRoot
              after={after}
              autoFocus={autoFocus}
              isEmpty={isEmpty}
              stored={Boolean(stored)}
              updates={updates}
            />
          </ComposerInputContext.Provider>
        </ThreadRevealContext.Provider>
      </ThreadSettingsContext.Provider>
    </ThreadComponentsContext.Provider>
  )
}

/**
 * Keeps the turn the viewport pins at the top when the reply's id changes as
 * the run ends. While it waits the runtime shows a placeholder reply, and a
 * reply that arrives in one piece replaces it in the same update that ends
 * the run. assistant-ui (still in 0.15.31) then drops the turn as stale and
 * takes away the space it held below the reply, so the view scrolled back up
 * over the previous reply. The turn moves to the reply that replaced the
 * placeholder.
 */
const KeepTurnAnchor: FC = () => {
  const viewport = useThreadViewportStore()
  const aui = useAui()
  useEffect(
    () =>
      viewport.subscribe((state, previous) => {
        const turn = previous.topAnchorTurn
        if (state.topAnchorTurn || !turn) return
        const messages = aui.thread().getState().messages
        const reply = messages.at(-1)
        if (
          messages.at(-2)?.id === turn.anchorId &&
          reply?.role === "assistant" &&
          reply.id !== turn.targetId
        ) {
          state.setTopAnchorTurn({
            anchorId: turn.anchorId,
            targetId: reply.id,
          })
        }
      }),
    [viewport, aui]
  )
  return null
}

/**
 * Keeps the owner's message at the top until their next send, and the end of
 * the thread in view. assistant-ui follows the bottom by itself only when the
 * viewport is not anchored to a turn.
 *
 * - The space assistant-ui holds below a pinned reply is measured here as
 *   well, the moment anything under the owner's message resizes. The footer
 *   sits in the scroll content, so a tray leaving, or the viewport growing,
 *   left the content short and the browser clamped the scroll before
 *   assistant-ui measured again a frame later: the owner's message dropped by
 *   the tray's height, and the drop stayed.
 * - A footer that appears or grows (the tray) under a reply that already
 *   fills the view covers its last lines, so a reader at its end stays there.
 * - The after slot sits in the message group ahead of that space, so a card
 *   landing in it fills the space rather than landing below it.
 * - Between turns, what lands with no turn of the owner's (a message the
 *   assistant posted on its own, or a card in the slot) is followed: a reader
 *   at the bottom glides to it, and one who scrolled up is told instead.
 */
const FollowBottom: FC<{
  footer: HTMLElement | null
  after: HTMLElement | null
  onUnseen: (unseen: boolean) => void
  onBelow: (below: boolean) => void
}> = ({ footer, after, onUnseen, onBelow }) => {
  const store = useThreadViewportStore()
  const aui = useAui()
  const follow = useRef<() => void>(() => undefined)
  // A message added to the open thread: never the history loading in, nor
  // another thread opening.
  const count = useAuiState((s) => s.thread.messages.length)
  const thread = useAuiState((s) => s.threadListItem.id)
  const seen = useRef({ count, thread })
  useEffect(() => {
    const before = seen.current
    seen.current = { count, thread }
    if (before.thread === thread && before.count > 0 && count > before.count) {
      follow.current()
    }
  }, [count, thread])
  useEffect(() => {
    const viewport = footer?.closest<HTMLElement>(
      '[data-slot="aui_thread-viewport"]'
    )
    if (!footer || !after || !viewport) return
    const idle = () => !aui.thread().getState().isRunning
    // The end of the scroll content, the footer in it. assistant-ui's
    // `isViewportAtBottom` takes the footer's height as slack since 0.15.31,
    // which suits a footer laid over the messages, not ours.
    const atBottom = () =>
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 1
    const glide = (): ScrollBehavior =>
      matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth"
    // Read before a resize moves anything: scroll events come after it.
    let pinned = atBottom()
    let last = { top: viewport.scrollTop, height: viewport.scrollHeight }
    // Only the reader scrolling up lets go of the bottom. A scroll event that
    // lands while the tray is still growing (its height eases) reads short of
    // the bottom, and taking that as "not pinned" stopped the follow there,
    // 12 px up with nothing below.
    // Whether the end of the transcript is out of sight under the composer.
    // The space held below a pinned reply is room to scroll with nothing in
    // it, and Scroll to bottom over blank space took the reader nowhere.
    const below = () =>
      onBelow(
        after.getBoundingClientRect().bottom >
          footer.getBoundingClientRect().top + 1
      )
    // Where the view was before the content shrank and the browser clamped
    // the scroll, when that clamp's scroll event comes before the resize.
    let rest: number | null = null
    const onScroll = () => {
      const { scrollTop: top, scrollHeight: height } = viewport
      rest = pinned && top < last.top && height < last.height ? last.top : null
      if (top < last.top && height === last.height) pinned = false
      else if (atBottom()) pinned = true
      last = { top, height }
      if (pinned) onUnseen(false)
      below()
    }
    // A frame on, once the space below the reply is measured again.
    follow.current = () => {
      if (!idle()) return
      requestAnimationFrame(() => {
        if (atBottom()) return
        if (!pinned) return onUnseen(true)
        // Past the fold the held space is spent, so ending the turn moves nothing.
        if (
          after.getBoundingClientRect().bottom >
          footer.getBoundingClientRect().top
        ) {
          store.getState().setTopAnchorTurn(null)
        }
        requestAnimationFrame(() =>
          viewport.scrollTo({ top: viewport.scrollHeight, behavior: glide() })
        )
      })
    }
    // assistant-ui's own sum (`computeTopAnchorReserve`), run before the
    // frame paints instead of after it, so the two always agree. Gives the
    // space that was held before.
    const hold = () => {
      const { element, targetConfig: clamp } = store.getState()
      const { anchor } = element
      const reserve = viewport.querySelector<HTMLElement>(
        "[data-aui-top-anchor-reserve]"
      )
      if (!anchor || !clamp || !reserve) return 0
      const held = reserve.offsetHeight
      let top = 0
      for (
        let at: Element | null = anchor;
        at instanceof HTMLElement && at !== viewport;
        at = at.offsetParent
      ) {
        top += at.offsetTop
      }
      // A tall message is pinned with only its last lines in view.
      if (anchor.offsetHeight > clamp.tallerThan) {
        top += Math.max(0, anchor.offsetHeight - clamp.visibleHeight)
      }
      const space = top + viewport.clientHeight - (viewport.scrollHeight - held)
      reserve.style.height = `${Math.max(0, space)}px`
      return held
    }
    let height = footer.offsetHeight
    let slot = after.offsetHeight
    let size = `${viewport.clientWidth}x${viewport.clientHeight}`
    const observer = new ResizeObserver(() => {
      const held = hold()
      const shrank = footer.offsetHeight < height
      const grew = footer.offsetHeight > height
      height = footer.offsetHeight
      const next = `${viewport.clientWidth}x${viewport.clientHeight}`
      const resized = next !== size
      size = next
      const landed = after.offsetHeight > slot
      slot = after.offsetHeight
      if (landed) follow.current()
      // Puts back what the clamp took, then goes on to the bottom: with the
      // space held, where the owner's message sits at the top. A send that
      // takes the tray or Skip this one away with it glides there as a typed
      // one does; going straight to the bottom left assistant-ui no glide.
      const back = rest ?? last.top
      if ((shrank || resized) && pinned && viewport.scrollTop < back) {
        viewport.scrollTo({ top: back, behavior: "instant" })
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: glide() })
      }
      // A tray growing over that space leaves the message where it is; one
      // docking under a reply that already filled the view keeps the reader
      // at its end.
      if (grew && !held && pinned) {
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" })
      }
      // assistant-ui reads `isAtBottom` on a scroll, or on a resize that
      // changes the whole-pixel scrollHeight. A scroll to where it already
      // was fires no event, and a sub-pixel change of the tray skips its
      // resize, so Scroll to bottom stayed up 0.5 px from the bottom. Its
      // scroll handler reads the geometry as it is now.
      viewport.dispatchEvent(new Event("scroll"))
    })
    observer.observe(footer)
    observer.observe(viewport)
    observer.observe(after)
    // Each row, for the transcript outgrowing the space held below the reply.
    // Not their group: the held space sits in it, and sizing that above
    // resized an observed box inside its own callback, which the browser
    // logs as a ResizeObserver loop.
    const watch = (nodes: Iterable<Node>) => {
      for (const node of nodes) {
        if (
          node instanceof HTMLElement &&
          node !== after &&
          !node.hasAttribute("data-aui-top-anchor-reserve")
        ) {
          observer.observe(node)
        }
      }
    }
    const rows = new MutationObserver((records) => {
      for (const { addedNodes, removedNodes } of records) {
        watch(addedNodes)
        for (const node of removedNodes) {
          if (node instanceof Element) observer.unobserve(node)
        }
      }
    })
    if (after.parentElement) {
      watch(after.parentElement.children)
      rows.observe(after.parentElement, { childList: true })
    }
    viewport.addEventListener("scroll", onScroll, { passive: true })
    below()
    return () => {
      rows.disconnect()
      observer.disconnect()
      viewport.removeEventListener("scroll", onScroll)
      follow.current = () => undefined
    }
  }, [footer, after, store, aui, onUnseen, onBelow])
  return null
}

const ThreadRoot: FC<{
  isEmpty: boolean
  autoFocus: boolean
  stored: boolean
  after: ReactNode
  updates: ReactNode
}> = ({ isEmpty, autoFocus, stored, after, updates }) => {
  const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext)
  // Where the question tray docks, above the composer; each question's call
  // sits in the transcript and draws itself here.
  const [tray, setTray] = useState<HTMLElement | null>(null)
  const [footer, setFooter] = useState<HTMLElement | null>(null)
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const [unseen, setUnseen] = useState(false)
  const [below, setBelow] = useState(false)

  return (
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
            onBelow={setBelow}
            onUnseen={setUnseen}
          />
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
            <HistoryLoading stored={stored} />

            {/* The space assistant-ui holds below a pinned reply goes last,
                after the slot. An empty slot's margin takes back its gap. */}
            <div
              data-slot="aui_message-group"
              className="flex flex-col gap-y-6 has-[>:not(:empty)]:mb-14 [&>[data-aui-top-anchor-reserve]]:order-last"
            >
              <ThreadMessages />
              {/* Always in the page, so a card that appears in it is read out. */}
              <div aria-live="polite" className="empty:-mt-6" ref={setSlot}>
                {after}
              </div>
            </div>

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
                <SkipThisOne />
                <div className="empty:hidden" ref={setTray} />
                <Composer autoFocus={autoFocus} expanded={isEmpty} />
                {/* The same gap as the tray above the composer. */}
                {isEmpty ? updates : null}
              </div>
              <AuiIf condition={(s) => isEmpty && s.composer.isEmpty}>
                <ThreadSuggestions />
              </AuiIf>
            </ThreadPrimitive.ViewportFooter>
          </div>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </TraySlotProvider>
  )
}

const ThreadMessage: FC = () => {
  const { AssistantMessage: AssistantMessageComponent = AssistantMessage } =
    useContext(ThreadComponentsContext)
  const role = useAuiState((s) => s.message.role)

  return (
    <>
      <DateDivider />
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

/** The day a stored message was written, from the `createdAt` the server puts in `metadata.custom`. */
const createdAt = (message: MessageData | undefined): string | null => {
  const at = message?.metadata.custom.createdAt
  return typeof at === "string" ? at : null
}

/**
 * A rule with the date, above the first message of each day. A message with
 * no stored date draws none: the runtime's own `createdAt` is the time it was
 * rendered, which would date every old message today.
 */
const DateDivider: FC = () => {
  // The selectors return the stored strings as they are, so a streaming
  // update to another message costs a comparison, not a date parse.
  const at = useAuiState((s) => createdAt(s.message))
  const before = useAuiState((s) =>
    createdAt(s.thread.messages[s.message.index - 1])
  )
  const day = localDay(at)
  if (day === null || day === localDay(before)) return null
  return (
    <div
      data-slot="aui_date-divider"
      className="flex items-center gap-3 text-[0.8125rem] text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border"
    >
      <time dateTime={at ?? undefined}>{LOCAL_DAY.format(new Date(day))}</time>
    </div>
  )
}

/**
 * The owner's own calendar day, not UTC's: a message at 23:30Z in summer is
 * already tomorrow in the UK. The thread renders only in the browser, so the
 * reader's zone is the owner's zone and nothing has to match a server render.
 */
const LOCAL_DAY = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
})

/** Local midnight of the message's day, as a number to compare; null without a date. */
const localDay = (at: string | null): number | null => {
  if (!at) return null
  const date = new Date(at)
  return Number.isNaN(date.getTime()) ? null : localMidnight(date)
}

// It shows only after a short delay: on each send the viewport leaves the
// bottom for the moment it takes to glide the sent message up, and without
// the delay the button blinked on every send. Something that landed while the
// owner read further up makes it a "New message" pill. Nothing below the
// composer but held space hides it too.
const ThreadScrollToBottom: FC<{ unseen: boolean; below: boolean }> = ({
  unseen,
  below,
}) => {
  const className = cn(
    "aui-thread-scroll-to-bottom absolute -top-12 z-10 self-center rounded-full transition-[opacity,visibility] delay-500 disabled:invisible disabled:opacity-0 disabled:delay-0 motion-reduce:transition-none",
    !below && "invisible opacity-0 delay-0"
  )
  return (
    <ThreadPrimitive.ScrollToBottom
      behavior="smooth"
      render={
        unseen ? (
          <Button className={className} size="sm" variant="outline" />
        ) : (
          <TooltipIconButton
            className={className}
            size="icon"
            tooltip="Scroll to bottom"
            variant="outline"
          />
        )
      }
    >
      <ArrowDownIcon aria-hidden />
      {unseen ? "New message" : null}
    </ThreadPrimitive.ScrollToBottom>
  )
}

// No entrance motion: the page loads into the task, not into a show.
const ThreadWelcome: FC = () => {
  const { briefing } = useContext(ThreadSettingsContext)
  return (
    <div className="aui-thread-welcome-root mb-6 flex flex-col items-center px-4 text-center">
      <LogoMark className="mb-4 size-8 text-muted-foreground" />
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

/**
 * Skip this one, above the composer while an optional question asked in
 * words waits: a tap says so as the owner's message. A required one has none.
 */
const SkipThisOne: FC = () => {
  const aui = useAui()
  const sendable = useSendable()
  const waiting = useAuiState(
    (s) => !s.thread.isRunning && waitsToSkip(s.thread.messages.at(-1)?.parts)
  )
  if (!waiting || !sendable) return null
  return (
    <Button
      className="self-start rounded-full text-muted-foreground"
      data-slot="skip-this-one"
      onClick={() => aui.thread().append(SKIP_REPLY)}
      size="sm"
      type="button"
      variant="outline"
    >
      Skip this one
    </Button>
  )
}

/** One row per suggestion under the composer; a press sends it. */
const ThreadSuggestions: FC = () => {
  return (
    <ul
      aria-label="Suggestions"
      className="aui-thread-welcome-suggestions flex w-full flex-col empty:hidden"
    >
      <ThreadPrimitive.Suggestions>
        {() => <ThreadSuggestionItem />}
      </ThreadPrimitive.Suggestions>
    </ul>
  )
}

const ThreadSuggestionItem: FC = () => {
  return (
    <li className="aui-thread-welcome-suggestion-display">
      <SuggestionPrimitive.Trigger
        send
        render={
          <Button
            variant="ghost"
            className="aui-thread-welcome-suggestion h-auto min-h-10 w-full justify-start gap-3 whitespace-normal rounded-lg py-2 text-start font-normal text-muted-foreground"
          />
        }
      >
        <ArrowBendDownRightIcon aria-hidden />
        <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1" />
        <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 empty:hidden" />
      </SuggestionPrimitive.Trigger>
    </li>
  )
}

/**
 * The composer. `expanded` is the new chat's: the field above, and the plus and
 * send under it. Once there is a conversation it is one compact row.
 */
const Composer: FC<{ autoFocus: boolean; expanded: boolean }> = ({
  autoFocus,
  expanded,
}) => {
  const {
    placeholder = "Send a message",
    placeholderIdeas,
    questionPlaceholder,
    mode,
  } = useContext(ThreadSettingsContext)
  const input = useContext(ComposerInputContext)
  const idea =
    useCycle([placeholder, ...(placeholderIdeas ?? [])], 5000).item ?? ""
  // A question waits in the tray: what the owner types instead is an
  // ordinary turn, and the placeholder says so.
  const asking = useAuiState((s) =>
    waitsOnTray(s.thread.messages.at(-1)?.parts)
  )
  // Disabled, not only kept from sending: words typed into the placeholder
  // thread would stay behind with it when the stored one replaces it. The
  // input takes focus once it is enabled.
  const sendable = useSendable()
  useEffect(() => {
    if (mode) input.current?.focus()
  }, [mode, input])
  useTypeToComposer(input)
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      {/* No ring, only a lighter edge: the composer holds focus whenever the
          page is open, so anything heavier would never go away. */}
      <div
        data-slot="aui_composer-shell"
        className={cn(
          "flex w-full cursor-text gap-2 rounded-(--composer-radius) border border-border bg-(--composer-bg) p-(--composer-padding) transition-colors focus-within:border-field-focus",
          expanded ? "flex-wrap items-center" : "items-end"
        )}
      >
        {mode ? <ComposerMode input={input} /> : <QuickActions input={input} />}
        <ComposerPrimitive.Input
          ref={input}
          placeholder={
            mode?.placeholder ??
            (asking && questionPlaceholder ? questionPlaceholder : idea)
          }
          className={cn(
            "aui-composer-input max-h-48 min-w-0 resize-none bg-transparent px-1.5 py-1.25 text-chat text-chat-foreground caret-primary outline-none placeholder:text-muted-foreground/60",
            expanded ? "order-first min-h-16 basis-full" : "min-h-9 flex-1"
          )}
          rows={1}
          autoFocus={autoFocus}
          disabled={!sendable}
          enterKeyHint="send"
          aria-label="Message input"
        />
        <ComposerSend expanded={expanded} />
      </div>
    </ComposerPrimitive.Root>
  )
}

const QuickActions: FC<{ input: RefObject<HTMLTextAreaElement | null> }> = ({
  input,
}) => {
  const { quickActions } = useContext(ThreadSettingsContext)
  const aui = useAui()
  // Focus goes to the composer after a pick, so the owner can finish the
  // sentence; Escape still hands it back to the button.
  const after = useRef<HTMLElement | null>(null)
  // A pick writes into the composer, which waits with it.
  const sendable = useSendable()
  if (!quickActions?.length) return null
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) after.current = null
      }}
    >
      <DropdownMenuTrigger
        disabled={!sendable}
        render={
          <Button
            aria-label="Quick actions"
            className="aui-composer-quick-actions m-0.5 size-8 border-foreground/10 text-muted-foreground/80 hover:text-foreground"
            size="icon"
            type="button"
            variant="outline"
          />
        }
      >
        <PlusIcon aria-hidden className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent finalFocus={() => after.current ?? true} side="top">
        {quickActions.map((action) => (
          <DropdownMenuItem
            key={action.title}
            onClick={() => {
              after.current = input.current
              // A draft is the owner's words: add to it, never replace it.
              const draft = aui.composer().getState().text.trimEnd()
              aui
                .composer()
                .setText(draft ? `${draft}\n${action.prompt}` : action.prompt)
            }}
          >
            {action.title}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Typing with focus outside any field goes to the composer: focus moves
 * there on the key that starts it, and that key's character is typed in it. Without it,
 * focus left on a link or a closed card ate the words, and on 2026-10-25 a
 * sentence typed with focus on the rail's Chat link opened another
 * conversation. Space alone on a control stays the control's own.
 */
function useTypeToComposer(input: RefObject<HTMLTextAreaElement | null>) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key.length !== 1 ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return
      const target = event.target as HTMLElement | null
      if (!target || target === input.current) return
      if (
        target.closest(
          "input, textarea, select, [contenteditable], [role=dialog], [role=menu], [role=listbox]"
        )
      )
        return
      if (event.key === " " && target !== document.body) return
      const field = input.current
      if (!field || field.disabled) return
      // Typed here, not left to the key: a key whose focus moved mid-press
      // can drop its character. insertText keeps the editor's undo and
      // fires the input event React reads.
      event.preventDefault()
      field.focus()
      if (document.execCommand?.("insertText", false, event.key)) return
      field.setRangeText(
        event.key,
        field.selectionStart,
        field.selectionEnd,
        "end"
      )
      field.dispatchEvent(new Event("input", { bubbles: true }))
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [input])
}

/**
 * The composer's mode in place of "+": its icon alone, named by its tooltip.
 * Pressing it leaves the mode, and the × it turns into on hover says so;
 * focus stays in the composer.
 */
const ComposerMode: FC<{ input: RefObject<HTMLTextAreaElement | null> }> = ({
  input,
}) => {
  const { mode } = useContext(ThreadSettingsContext)
  if (!mode) return null
  return (
    <TooltipIconButton
      className="group/mode m-0.5 size-8 rounded-full border-primary/30 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary [&_svg]:size-3.5"
      data-slot="aui_composer-mode"
      onClick={() => {
        mode.onClear()
        input.current?.focus()
      }}
      side="top"
      size="icon"
      tooltip={`${mode.label} mode. Press to leave it`}
      type="button"
      variant="outline"
    >
      <span className="contents group-hover/mode:hidden group-focus-visible/mode:hidden">
        {mode.icon}
      </span>
      <XIcon
        aria-hidden
        className="hidden group-hover/mode:block group-focus-visible/mode:block"
      />
    </TooltipIconButton>
  )
}

const ComposerSend: FC<{ expanded: boolean }> = ({ expanded }) => {
  const sendable = useSendable()
  return (
    // In the expanded composer the buttons sit under the field, send at the right.
    <div className={cn("flex", expanded && "ms-auto")}>
      <AuiIf condition={(s) => !s.thread.isRunning}>
        <ComposerPrimitive.Send
          disabled={!sendable}
          render={
            <TooltipIconButton
              tooltip="Send message"
              side="bottom"
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-send"
              aria-label="Send message"
            />
          }
        >
          <ArrowUpIcon
            className="aui-composer-send-icon size-4"
            weight="bold"
          />
        </ComposerPrimitive.Send>
      </AuiIf>
      <AuiIf condition={(s) => s.thread.isRunning}>
        <ComposerPrimitive.Cancel
          render={
            <Button
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-cancel"
              aria-label="Stop generating"
            />
          }
        >
          <SquareIcon
            className="aui-composer-cancel-icon size-3.5"
            weight="fill"
          />
        </ComposerPrimitive.Cancel>
      </AuiIf>
    </div>
  )
}

const MessageError: FC = () => {
  const ended = useAuiState(
    (s) =>
      s.message.status?.type === "incomplete" &&
      s.message.status.error === SESSION_ENDED
  )
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root mt-2 rounded-2xl border border-destructive bg-destructive/10 p-3 text-destructive text-sm dark:bg-destructive/5">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
        {ended ? (
          <a
            className="mt-1 inline-block font-medium text-foreground underline underline-offset-4"
            href={`/sign-in?returnTo=${encodeURIComponent(window.location.pathname)}`}
          >
            Sign in again
          </a>
        ) : null}
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  )
}

/**
 * The reply's one status line until its first words arrive. It gives way to
 * a call at work, whose own line or card is the progress ("Passing on your
 * change", Saving), so two never stack. A played-in opening is not work, so
 * it shows the line at once; a real turn waits out the status line's delay.
 */
const TypingIndicator: FC<{ immediate?: boolean }> = ({
  immediate = false,
}) => {
  const { assistant } = useContext(ThreadSettingsContext)
  const shown = useAuiState(
    (s) => !immediate && showsProgress(s.message.parts, COS_QUIET)
  )
  const status = useOnboardingStatus()
  const toolsRan = useAuiState((s) =>
    s.message.parts.some((part) => part.type === "tool-call")
  )
  // The line moves on at fixed times, so what it says stays true: more
  // time has passed.
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const timers = [THINKING_AFTER, STILL_ON_IT_AFTER].map((at) =>
      setTimeout(() => setSeconds(at), at * 1000)
    )
    return () => {
      for (const timer of timers) clearTimeout(timer)
    }
  }, [])
  if (shown) return null
  const ctx = { orgId: "", assistant }
  return (
    <span data-slot="aui_assistant-message-indicator">
      <StatusLine
        // The first beat of a turn is the dots alone: the same words every
        // turn read as a script.
        bare={!status && !immediate && !toolsRan && seconds < THINKING_AFTER}
        delay={immediate ? 0 : SHOW_DELAY_MS}
        kind={
          status
            ? onboardingKind(status)
            : immediate || toolsRan
              ? "writing"
              : turnKind(seconds)
        }
        label={
          status
            ? onboardingLine(status)
            : immediate || toolsRan
              ? writingBack(ctx)
              : turnMoment(seconds, ctx)
        }
      />
    </span>
  )
}

/** How long a played-in message shows the typing dot, then takes over its words. */
const REVEAL_TYPING_MS = 700
const REVEAL_TYPING_REDUCED_MS = 300
const REVEAL_WRITING_MS = 1100

/** Each word with the space after it, so a prefix reads as the text so far. */
const wordsOf = (text: string) => text.match(/\S+\s*/g) ?? []

type Reveal =
  /** Not played in: the message as it stands. */
  | { phase: "still" }
  | { phase: "typing" }
  | { phase: "writing"; text: string }
  /** Played in, and done: the whole message, its cards fading in. */
  | { phase: "played" }

/**
 * Plays in the opening message, alone in the thread, the first time this
 * browser shows it. Decided once, when the message first renders, so a
 * history that loads later never replays it. The owner typing or sending
 * ends it at once, and less motion skips the words.
 */
const useReveal = (): Reveal => {
  const reveal = useContext(ThreadRevealContext)
  const aui = useAui()
  const [words] = useState(() => {
    const message = aui.message().getState()
    const opening =
      message.role === "assistant" &&
      message.index === 0 &&
      aui.thread().getState().messages.length === 1
    if (!reveal || !opening || !reveal.unseen(message.id, createdAt(message)))
      return null
    return wordsOf(
      message.parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n\n")
    )
  })
  const id = useAuiState((s) => s.message.id)
  const [shown, setShown] = useState<number | null>(null)
  const [over, setOver] = useState(false)
  const interrupted = useAuiState(
    (s) => !s.thread.composer.isEmpty || s.thread.messages.length > 1
  )
  useEffect(() => {
    if (interrupted) setOver(true)
  }, [interrupted])
  useEffect(() => {
    if (!words) return
    reveal?.seen(id)
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches
    // About a second for the words whatever their number, within reason.
    const step = Math.min(60, Math.max(12, REVEAL_WRITING_MS / words.length))
    const write = (count: number) => {
      if (count >= words.length) return setOver(true)
      setShown(count)
      timer = setTimeout(() => write(count + 1), step)
    }
    let timer = setTimeout(
      () => (reduced ? setOver(true) : write(1)),
      reduced ? REVEAL_TYPING_REDUCED_MS : REVEAL_TYPING_MS
    )
    return () => clearTimeout(timer)
  }, [words, reveal, id])
  if (!words) return { phase: "still" }
  if (over) return { phase: "played" }
  if (shown === null) return { phase: "typing" }
  return { phase: "writing", text: words.slice(0, shown).join("") }
}

const AssistantMessage: FC = () => {
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup = DefaultToolGroup,
    ReasoningGroup = DefaultReasoningGroup,
  } = useContext(ThreadComponentsContext)
  const ACTION_BAR_PT = "pt-1.5"
  // Keep the action bar inside the contained root's paint box, then cancel its reserved space in flow.
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`

  const reveal = useReveal()
  const running = useAuiState((s) => s.message.status?.type === "running")
  const writing =
    running || reveal.phase === "typing" || reveal.phase === "writing"

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="group/message relative -mb-7.5 ps-2 pb-7.5 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <div className="min-w-0">
        <div
          data-slot="aui_assistant-message-content"
          // What follows words still typing in waits for them (the markdown
          // reads running until its reveal catches up), so a card under them
          // shows where it settles instead of sliding down as they grow.
          className="wrap-break-word pe-2 text-chat text-chat-foreground [&>.aui-md[data-status=running]~*]:invisible"
          // A played-in message is read out once, whole, when it is done.
          aria-live={reveal.phase === "still" ? undefined : "polite"}
        >
          {reveal.phase === "typing" ? (
            <TypingIndicator immediate />
          ) : reveal.phase === "writing" ? (
            <div aria-hidden>
              <TextMessagePartProvider isRunning text={reveal.text}>
                <MarkdownText />
              </TextMessagePartProvider>
            </div>
          ) : (
            <MessagePrimitive.GroupedParts groupBy={groupThreadParts}>
              {({ part, children }) => {
                switch (part.type) {
                  case "group-chainOfThought":
                    return (
                      <div data-slot="aui_chain-of-thought">{children}</div>
                    )
                  case "group-tool":
                    return <ToolGroup group={part}>{children}</ToolGroup>
                  case "group-reasoning":
                    return (
                      <ReasoningGroup group={part}>{children}</ReasoningGroup>
                    )
                  case "text":
                    return <MarkdownText />
                  case "reasoning":
                    return <Reasoning {...part} />
                  case "tool-call": {
                    const card = part.toolUI ?? (
                      <ToolFallbackComponent {...part} />
                    )
                    // Played in: the cards follow the words.
                    return reveal.phase === "played" ? (
                      <div className="fade-in animate-in duration-enter ease-standard motion-reduce:animate-none">
                        {card}
                      </div>
                    ) : (
                      card
                    )
                  }
                  case "data":
                    return part.dataRendererUI
                  case "indicator":
                    return <TypingIndicator />
                  default:
                    return null
                }
              }}
            </MessagePrimitive.GroupedParts>
          )}
          <MessageError />
        </div>

        {/* Its space is held from the start, but nothing under the words
            shows (or counts as moving) until the reply is done. */}
        <div
          data-slot="aui_assistant-message-footer"
          className={cn(
            "flex items-center gap-2",
            ACTION_BAR_HEIGHT,
            writing && "invisible"
          )}
        >
          <MessageTime />
          {/* A message of cards alone has no words to rate. */}
          <AuiIf
            condition={(s) =>
              s.message.parts.some((part) => part.type === "text")
            }
          >
            <AssistantActionBar />
          </AuiIf>
        </div>
      </div>
    </MessagePrimitive.Root>
  )
}

/**
 * The owner's thumb on a reply with words in it, when the runtime records
 * one. Each is a toggle a screen reader hears as pressed, and the thumb
 * fills once it is.
 */
const Feedback: FC = () => {
  const rated = useAuiState((s) => s.message.metadata.submittedFeedback?.type)
  return (
    <AuiIf condition={(s) => s.thread.capabilities.feedback}>
      <ActionBarPrimitive.FeedbackPositive
        render={
          <TooltipIconButton
            aria-pressed={rated === "positive"}
            tooltip="Helpful"
          />
        }
      >
        <ThumbsUpIcon weight={rated === "positive" ? "fill" : "regular"} />
      </ActionBarPrimitive.FeedbackPositive>
      <ActionBarPrimitive.FeedbackNegative
        render={
          <TooltipIconButton
            aria-pressed={rated === "negative"}
            tooltip="Not helpful"
          />
        }
      >
        <ThumbsDownIcon weight={rated === "negative" ? "fill" : "regular"} />
      </ActionBarPrimitive.FeedbackNegative>
    </AuiIf>
  )
}

/**
 * The thumbs only. No Reload and no Edit: the server writes every turn and
 * owns the history, so a regenerated or rewritten turn would only ever exist
 * on this screen. They show on hover or focus rather than through `autohide`,
 * which unmounts them until the pointer arrives, so a keyboard could never
 * reach them and a touch screen never see them. Nor `hideWhenRunning`: it
 * took every reply's thumbs down on each send and drew them all again when
 * the turn ended. The reply being written hides its own footer.
 */
const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root className="aui-assistant-action-bar-root flex gap-1 text-muted-foreground opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/message:opacity-100 [@media(hover:none)]:opacity-100">
      <Feedback />
    </ActionBarPrimitive.Root>
  )
}

/** When a message was written: the stored date, else the runtime's own for one sent here. */
const sentAt = (message: MessageData): string =>
  createdAt(message) ?? message.createdAt.toISOString()

const LOCAL_TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
})

const MessageTime: FC = () => {
  const at = useAuiState((s) => sentAt(s.message))
  return (
    <time
      className="text-[0.6875rem] text-muted-foreground tabular-nums"
      dateTime={at}
    >
      {LOCAL_TIME.format(new Date(at))}
    </time>
  )
}

type Delivery = "sent" | "delivered" | "seen"

/**
 * How far the owner's message has got, read from the message after it: none
 * yet is sent, an empty reply is the assistant thinking, a reply with anything
 * in it is seen. A reply that ended in an error leaves it sent.
 */
const deliveryOf = (s: AssistantState): Delivery => {
  const next = s.thread.messages[s.message.index + 1]
  if (next?.role !== "assistant") return "sent"
  // A turn refused or broken before Reme read it never arrived.
  if (next.status?.type === "incomplete" && next.status.reason === "error")
    return "sent"
  return next.content.length > 0 ? "seen" : "delivered"
}

const DELIVERY = {
  sent: { label: "Sent", Icon: CheckIcon },
  delivered: { label: "Delivered", Icon: ChecksIcon },
  seen: { label: "Seen", Icon: ChecksIcon },
} as const

const DeliveryTick: FC = () => {
  const delivery = useAuiState(deliveryOf)
  const { label, Icon } = DELIVERY[delivery]
  return (
    <span data-slot="aui_user-message-delivery" data-state={delivery}>
      <Icon
        aria-hidden
        className={cn("size-3", delivery === "seen" && "text-primary")}
      />
      <span className="sr-only">{label}</span>
    </span>
  )
}

const UserText: FC = () => (
  <p className="whitespace-pre-line">
    <MessagePartPrimitive.Text />
  </p>
)

const USER_PARTS = { Text: UserText }

const UserMessage: FC = () => {
  // A skipped question's reply is a note in the thread, not words the owner said.
  const skipped = useAuiState((s) => {
    const [only, ...rest] = s.message.parts
    return rest.length === 0 && only?.type === "text" && only.text === SKIPPED
  })
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div
          className={cn(
            "aui-user-message-content wrap-break-word relative rounded-3xl bg-muted px-4 py-2.5 text-chat empty:hidden sm:px-5 sm:py-3",
            skipped ? "text-muted-foreground" : "text-chat-foreground"
          )}
        >
          <MessagePrimitive.Parts components={USER_PARTS} />
        </div>
        <span
          data-slot="aui_user-message-meta"
          className="me-2 mt-1 flex items-center justify-end gap-1 text-muted-foreground"
        >
          <MessageTime />
          <DeliveryTick />
        </span>
      </div>
    </MessagePrimitive.Root>
  )
}
