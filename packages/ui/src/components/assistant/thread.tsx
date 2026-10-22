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
import { OWNER_CARDS } from "@workspace/ui/components/assistant/approval"
import { TraySlotProvider } from "@workspace/ui/components/assistant/ask-design"
import { COS_QUIET } from "@workspace/ui/components/assistant/cos-tools"
import { MarkdownText } from "@workspace/ui/components/assistant/markdown-text"
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
import { PersonaAvatar } from "@workspace/ui/components/persona"
import { ComposerInputContext } from "@workspace/ui/hooks/use-composer-input"
import {
  PLAN_CHANGES_PLACEHOLDER,
  waitsOnBlueprint,
} from "@workspace/ui/lib/blueprint"
import {
  QUOTE_CHANGES_PLACEHOLDER,
  waitsOnQuoteForm,
} from "@workspace/ui/lib/quote-form"
import { SESSION_ENDED, waitsOnDesign } from "@workspace/ui/lib/tool-state"
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
 * A mode the composer is in: a chip beside "+" names it, and its placeholder
 * replaces the thread's. `onClear` is the chip's ×.
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
  /** The composer's placeholder while design questions are open above it. */
  questionPlaceholder?: string | undefined
  /** One line under the welcome heading, built from state rather than a model. */
  briefing?: string | null | undefined
  quickActions?: readonly ThreadQuickAction[] | undefined
  /** A new mode object focuses the composer, so each press lands there. */
  mode?: ThreadMode | undefined
  /**
   * Drawn after the last message, from app state rather than the thread,
   * such as the card that says a build is ready. Announced when it appears.
   */
  after?: ReactNode
  /**
   * Plays the conversation's opening message in the first time it is seen,
   * as a reply being written: the typing dot, then the words, then its
   * cards. `unseen` says whether this browser has shown that message;
   * `seen` records that it now has.
   */
  reveal?: ThreadReveal | undefined
  /** What the owner calls the assistant, named above each reply. */
  assistantName?: string | undefined
}

export type ThreadReveal = {
  unseen: (messageId: string, createdAt: string | null) => boolean
  seen: (messageId: string) => void
}

type ThreadSettings = Omit<ThreadProps, "components" | "autoFocus" | "after">

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

/** Steps through `items` every few seconds; one item stays put. */
const useCycle = (items: readonly string[]) => {
  const [at, setAt] = useState(0)
  const count = items.length
  useEffect(() => {
    if (count < 2) return
    const timer = setInterval(() => setAt((each) => each + 1), 5000)
    return () => clearInterval(timer)
  }, [count])
  return items[at % count] ?? ""
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
  reveal,
  assistantName,
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
      reveal,
      assistantName,
    }),
    [
      stored,
      placeholder,
      placeholderIdeas,
      questionPlaceholder,
      briefing,
      quickActions,
      mode,
      reveal,
      assistantName,
    ]
  )
  // The composer's input, which a card can hand the owner to.
  const input = useRef<HTMLTextAreaElement>(null)

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadSettingsContext.Provider value={settings}>
        <ComposerInputContext.Provider value={input}>
          <ThreadRoot
            after={after}
            autoFocus={autoFocus}
            isEmpty={isEmpty}
            stored={Boolean(stored)}
          />
        </ComposerInputContext.Provider>
      </ThreadSettingsContext.Provider>
    </ThreadComponentsContext.Provider>
  )
}

/**
 * Keeps the turn the viewport pins at the top when the reply's id changes as
 * the run ends. While it waits the runtime shows a placeholder reply, and a
 * reply that arrives in one piece replaces it in the same update that ends
 * the run. assistant-ui 0.15.22 then drops the turn as stale and takes away
 * the space it held below the reply, so the view scrolled back up over the
 * previous reply. The turn moves to the reply that replaced the placeholder.
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
 * The slot after the last message, from app state. The space assistant-ui
 * holds below a pinned reply is sized from the reply alone and never from
 * this slot, so when a card here shrinks or goes (the ready card on Approve)
 * that space stays and the view settles on blank above the composer until a
 * reload. A shrink with no run going ends the pinned turn, which takes the
 * space away.
 */
const AfterSlot: FC<{ children: ReactNode }> = ({ children }) => {
  const viewport = useThreadViewportStore()
  const aui = useAui()
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!slot) return
    let height = slot.offsetHeight
    const observer = new ResizeObserver(() => {
      const next = slot.offsetHeight
      if (next < height && !aui.thread().getState().isRunning) {
        viewport.getState().setTopAnchorTurn(null)
      }
      height = next
    })
    observer.observe(slot)
    return () => observer.disconnect()
  }, [slot, viewport, aui])
  return (
    // Always in the page, so a card that appears in it is read out.
    <div aria-live="polite" className="-mt-8 mb-14 empty:m-0" ref={setSlot}>
      {children}
    </div>
  )
}

const ThreadRoot: FC<{
  isEmpty: boolean
  autoFocus: boolean
  stored: boolean
  after: ReactNode
}> = ({ isEmpty, autoFocus, stored, after }) => {
  const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext)
  // Where the design tray docks, above the composer; the tray's call sits in
  // the transcript and draws itself here.
  const [tray, setTray] = useState<HTMLElement | null>(null)

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
          className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth pe-(--panel-inset)"
        >
          <KeepTurnAnchor />
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

            <div
              data-slot="aui_message-group"
              className="mb-14 flex flex-col gap-y-6 empty:hidden"
            >
              <ThreadPrimitive.Messages>
                {() => <ThreadMessage />}
              </ThreadPrimitive.Messages>
            </div>
            <AfterSlot>{after}</AfterSlot>

            <ThreadPrimitive.ViewportFooter
              className={cn(
                "aui-thread-viewport-footer flex flex-col gap-4 overflow-visible bg-background pb-4 md:pb-6",
                !isEmpty &&
                  "sticky bottom-0 mt-auto rounded-t-(--composer-radius)"
              )}
            >
              <ThreadScrollToBottom />
              <div className="flex flex-col gap-2">
                <div className="empty:hidden" ref={setTray} />
                <Composer autoFocus={autoFocus} expanded={isEmpty} />
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
// the delay the button blinked on every send.
const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom
      render={
        <TooltipIconButton
          tooltip="Scroll to bottom"
          variant="outline"
          size="icon"
          className="aui-thread-scroll-to-bottom absolute -top-12 z-10 self-center rounded-full transition-[opacity,visibility] delay-500 duration-150 disabled:invisible disabled:opacity-0 disabled:delay-0 motion-reduce:transition-none"
        />
      }
    >
      <ArrowDownIcon />
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
  const idea = useCycle([placeholder, ...(placeholderIdeas ?? [])])
  // A proposed quote form waits on the owner: what they type next is their
  // change to it, and the placeholder says so.
  const reviewing = useAuiState((s) =>
    waitsOnQuoteForm(s.thread.messages.at(-1)?.parts)
  )
  const planning = useAuiState((s) =>
    waitsOnBlueprint(s.thread.messages.at(-1)?.parts)
  )
  const asking = useAuiState((s) =>
    waitsOnDesign(s.thread.messages.at(-1)?.parts)
  )
  // Disabled, not only kept from sending: words typed into the placeholder
  // thread would stay behind with it when the stored one replaces it. The
  // input takes focus once it is enabled.
  const sendable = useSendable()
  useEffect(() => {
    if (mode) input.current?.focus()
  }, [mode, input])
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
        <QuickActions input={input} />
        <ComposerMode input={input} />
        <ComposerPrimitive.Input
          ref={input}
          placeholder={
            mode?.placeholder ??
            (reviewing
              ? QUOTE_CHANGES_PLACEHOLDER
              : planning
                ? PLAN_CHANGES_PLACEHOLDER
                : asking && questionPlaceholder
                  ? questionPlaceholder
                  : idea)
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
            className="aui-composer-quick-actions border-foreground/10 text-muted-foreground hover:text-foreground"
            size="icon"
            type="button"
            variant="outline"
          />
        }
      >
        <PlusIcon aria-hidden className="size-4" />
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

/** The chip naming the composer's mode; its × leaves it and keeps focus in the composer. */
const ComposerMode: FC<{ input: RefObject<HTMLTextAreaElement | null> }> = ({
  input,
}) => {
  const { mode } = useContext(ThreadSettingsContext)
  if (!mode) return null
  return (
    <span
      data-slot="aui_composer-mode"
      className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-full bg-primary/10 pr-0.5 pl-2.5 font-medium text-primary text-xs [&_svg]:size-3.5 [&_svg]:shrink-0"
    >
      {mode.icon}
      <span className="truncate">{mode.label}</span>
      <Button
        aria-label={`Leave ${mode.label.toLowerCase()} mode`}
        className="rounded-full text-primary hover:bg-primary/15 hover:text-primary"
        onClick={() => {
          mode.onClear()
          input.current?.focus()
        }}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <XIcon aria-hidden />
      </Button>
    </span>
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
 * The dot a reply shows until its first words arrive. Quiet, and not under a
 * card that already says it is working (Saving, Stopping): the owner has
 * answered it and its own line is the progress.
 */
const TypingIndicator: FC = () => {
  const answered = useAuiState((s) =>
    s.message.parts.some(
      (part) =>
        part.type === "tool-call" &&
        part.result === undefined &&
        part.approval?.approved !== undefined
    )
  )
  if (answered) return null
  return (
    <span data-slot="aui_assistant-message-indicator" role="status">
      <span
        aria-hidden
        className="animate-pulse font-sans text-muted-foreground motion-reduce:animate-none"
      >
        {"●"}
      </span>
      <span className="sr-only">Working</span>
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
  const { reveal } = useContext(ThreadSettingsContext)
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
  const { assistantName = "Reme" } = useContext(ThreadSettingsContext)

  const ACTION_BAR_PT = "pt-1.5"
  // Keep the action bar inside the contained root's paint box, then cancel its reserved space in flow.
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`

  const reveal = useReveal()
  const writing = reveal.phase === "typing" || reveal.phase === "writing"

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="group/message relative -mb-7.5 ps-2 pb-7.5 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <div
        data-slot="aui_assistant-message-header"
        className="mb-1.5 flex items-center gap-2"
      >
        <PersonaAvatar className="size-6" />
        <span className="font-semibold text-foreground text-sm">
          {assistantName}
        </span>
      </div>
      <div className="min-w-0">
        <div
          data-slot="aui_assistant-message-content"
          className="wrap-break-word pe-2 text-chat text-chat-foreground"
          // A played-in message is read out once, whole, when it is done.
          aria-live={reveal.phase === "still" ? undefined : "polite"}
        >
          {reveal.phase === "typing" ? (
            <TypingIndicator />
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
                      <div className="fade-in animate-in duration-200 motion-reduce:animate-none">
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

        <div
          data-slot="aui_assistant-message-footer"
          className={cn("flex items-center gap-2", ACTION_BAR_HEIGHT)}
        >
          <MessageTime held={writing} />
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
 * reach them and a touch screen never see them.
 */
const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      className="aui-assistant-action-bar-root flex gap-1 text-muted-foreground opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/message:opacity-100 [@media(hover:none)]:opacity-100"
    >
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

/**
 * Held back, in its place, while the reply is still being written, so
 * nothing under the words moves but the words.
 */
const MessageTime: FC<{ held?: boolean }> = ({ held = false }) => {
  const at = useAuiState((s) => sentAt(s.message))
  const running = useAuiState((s) => s.message.status?.type === "running")
  return (
    <time
      className={cn(
        "text-[0.6875rem] text-muted-foreground tabular-nums",
        (running || held) && "invisible"
      )}
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
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content wrap-break-word relative rounded-3xl bg-muted px-4 py-2.5 text-chat text-chat-foreground empty:hidden sm:px-5 sm:py-3">
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
