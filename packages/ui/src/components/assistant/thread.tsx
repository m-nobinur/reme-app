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
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
  useAui,
  useAuiState,
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
import { MarkdownText } from "@workspace/ui/components/assistant/markdown-text"
import {
  ReasoningGroup as DefaultReasoningGroup,
  Reasoning,
} from "@workspace/ui/components/assistant/reasoning"
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
import { Skeleton } from "@workspace/ui/components/skeleton"
import { SESSION_ENDED } from "@workspace/ui/lib/tool-state"
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
   * A stored conversation, at its own address. It is never a new chat: while
   * its history loads it shows a skeleton, never the welcome or suggestions.
   */
  stored?: boolean | undefined
  autoFocus?: boolean | undefined
  placeholder?: string | undefined
  /** One line under the welcome heading, built from state rather than a model. */
  briefing?: string | null | undefined
  quickActions?: readonly ThreadQuickAction[] | undefined
  /** A new mode object focuses the composer, so each press lands there. */
  mode?: ThreadMode | undefined
}

type ThreadSettings = Omit<ThreadProps, "components" | "autoFocus">

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
    Object.hasOwn(OWNER_CARDS, part.toolName))
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

const ThreadHistorySkeleton: FC = () => (
  <div
    data-slot="aui_thread-history-skeleton"
    role="status"
    className="fade-in flex animate-in flex-col gap-y-6 fill-mode-both [animation-delay:150ms] [animation-duration:200ms] motion-reduce:animate-none"
  >
    <span className="sr-only">Loading conversation</span>
    <Skeleton className="ml-auto h-9 w-2/5 rounded-3xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-11/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-4/5 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-3/5 motion-reduce:animate-none" />
    </div>
    <Skeleton className="ml-auto h-9 w-1/3 rounded-3xl motion-reduce:animate-none" />
    <div className="flex flex-col gap-y-2">
      <Skeleton className="h-4 w-10/12 motion-reduce:animate-none" />
      <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
    </div>
  </div>
)

export const Thread: FC<ThreadProps> = ({
  components = EMPTY_COMPONENTS,
  autoFocus = true,
  stored = false,
  placeholder,
  briefing,
  quickActions,
  mode,
}) => {
  const isEmpty = useAuiState((s) => !stored && isNewChatView(s))
  const settings = useMemo(
    () => ({ placeholder, briefing, quickActions, mode }),
    [placeholder, briefing, quickActions, mode]
  )

  return (
    <ThreadComponentsContext.Provider value={components}>
      <ThreadSettingsContext.Provider value={settings}>
        <ThreadRoot autoFocus={autoFocus} isEmpty={isEmpty} stored={stored} />
      </ThreadSettingsContext.Provider>
    </ThreadComponentsContext.Provider>
  )
}

const ThreadRoot: FC<{
  isEmpty: boolean
  autoFocus: boolean
  stored: boolean
}> = ({ isEmpty, autoFocus, stored }) => {
  const { Welcome = ThreadWelcome } = useContext(ThreadComponentsContext)

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root @container flex h-full flex-col bg-background"
      style={{
        ["--thread-max-width" as string]: "44rem",
        ["--composer-bg" as string]: "var(--color-card)",
        ["--composer-radius" as string]: "var(--radius-4xl)",
        ["--composer-padding" as string]: "8px",
      }}
    >
      <ThreadPrimitive.Viewport
        turnAnchor="top"
        data-slot="aui_thread-viewport"
        className="relative flex flex-1 flex-col overflow-x-auto overflow-y-scroll scroll-smooth"
      >
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
          <AuiIf
            condition={(s) =>
              stored
                ? s.thread.messages.length === 0 &&
                  (s.thread.isLoading || s.threads.isLoading)
                : isHistoryLoadingView(s)
            }
          >
            <ThreadHistorySkeleton />
          </AuiIf>

          <div
            data-slot="aui_message-group"
            className="mb-14 flex flex-col gap-y-6 empty:hidden"
          >
            <ThreadPrimitive.Messages>
              {() => <ThreadMessage />}
            </ThreadPrimitive.Messages>
          </div>

          <ThreadPrimitive.ViewportFooter
            className={cn(
              "aui-thread-viewport-footer flex flex-col gap-4 overflow-visible bg-background pb-4 md:pb-6",
              !isEmpty &&
                "sticky bottom-0 mt-auto rounded-t-(--composer-radius)"
            )}
          >
            <ThreadScrollToBottom />
            <Composer autoFocus={autoFocus} />
            <AuiIf condition={(s) => isEmpty && s.composer.isEmpty}>
              <ThreadSuggestions />
            </AuiIf>
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
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

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom
      render={
        <TooltipIconButton
          tooltip="Scroll to bottom"
          variant="outline"
          size="icon"
          className="aui-thread-scroll-to-bottom absolute -top-12 z-10 self-center rounded-full disabled:invisible"
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

const Composer: FC<{ autoFocus: boolean }> = ({ autoFocus }) => {
  const { placeholder = "Send a message", mode } = useContext(
    ThreadSettingsContext
  )
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (mode) input.current?.focus()
  }, [mode])
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      {/* A one-pixel ring on top of the border: the composer holds focus
          whenever the page is open, so a heavy ring would never go away. */}
      <div
        data-slot="aui_composer-shell"
        className="flex w-full cursor-text flex-col gap-2 rounded-(--composer-radius) border border-border bg-(--composer-bg) p-(--composer-padding) transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring"
      >
        <ComposerPrimitive.Input
          ref={input}
          placeholder={mode?.placeholder ?? placeholder}
          className="aui-composer-input max-h-48 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-base leading-6 caret-primary outline-none placeholder:text-muted-foreground/60"
          rows={1}
          autoFocus={autoFocus}
          enterKeyHint="send"
          aria-label="Message input"
        />
        <ComposerAction input={input} />
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
  if (!quickActions?.length) return null
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) after.current = null
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button
            aria-label="Quick actions"
            className="aui-composer-quick-actions rounded-full text-muted-foreground hover:text-foreground"
            size="icon-sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <PlusIcon aria-hidden />
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

const ComposerAction: FC<{ input: RefObject<HTMLTextAreaElement | null> }> = ({
  input,
}) => {
  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1">
        <QuickActions input={input} />
        <ComposerMode input={input} />
      </div>
      <div className="flex items-center gap-1.5">
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send
            render={
              <TooltipIconButton
                tooltip="Send message"
                side="bottom"
                type="button"
                variant="default"
                size="icon"
                className="aui-composer-send size-8 rounded-full"
                aria-label="Send message"
              />
            }
          >
            <ArrowUpIcon className="aui-composer-send-icon size-4" />
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel
            render={
              <Button
                type="button"
                variant="default"
                size="icon"
                className="aui-composer-cancel size-8 rounded-full"
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

const AssistantMessage: FC = () => {
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup = DefaultToolGroup,
    ReasoningGroup = DefaultReasoningGroup,
  } = useContext(ThreadComponentsContext)

  const ACTION_BAR_PT = "pt-1.5"
  // Keep the action bar inside the contained root's paint box, then cancel its reserved space in flow.
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="group/message relative -mb-7.5 pb-7.5 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <div
        data-slot="aui_assistant-message-content"
        className="wrap-break-word px-2 text-foreground leading-relaxed"
      >
        <MessagePrimitive.GroupedParts groupBy={groupThreadParts}>
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return <div data-slot="aui_chain-of-thought">{children}</div>
              case "group-tool":
                return <ToolGroup group={part}>{children}</ToolGroup>
              case "group-reasoning":
                return <ReasoningGroup group={part}>{children}</ReasoningGroup>
              case "text":
                return <MarkdownText />
              case "reasoning":
                return <Reasoning {...part} />
              case "tool-call":
                return part.toolUI ?? <ToolFallbackComponent {...part} />
              case "data":
                return part.dataRendererUI
              case "indicator":
                return (
                  <span
                    data-slot="aui_assistant-message-indicator"
                    role="status"
                  >
                    <span
                      aria-hidden
                      className="animate-pulse font-sans motion-reduce:animate-none"
                    >
                      {"\u25cf"}
                    </span>
                    <span className="sr-only">Working</span>
                  </span>
                )
              default:
                return null
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center gap-2", ACTION_BAR_HEIGHT)}
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
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content wrap-break-word relative rounded-3xl bg-muted px-4 py-2 text-foreground empty:hidden">
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
