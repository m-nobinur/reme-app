import {
  ActionBarMorePrimitive,
  ActionBarPrimitive,
  type AssistantState,
  AuiIf,
  ComposerPrimitive,
  ErrorPrimitive,
  type GroupByContext,
  groupPartByType,
  type ThreadMessage as MessageData,
  MessagePrimitive,
  type PartState,
  SuggestionPrimitive,
  ThreadPrimitive,
  type ToolCallMessagePartComponent,
  useAui,
  useAuiState,
} from "@assistant-ui/react"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaretDownIcon,
  CheckIcon,
  CopyIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  MicrophoneIcon,
  PlusIcon,
  SquareIcon,
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { LogoMark } from "@workspace/ui/components/logo"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { SESSION_ENDED } from "@workspace/ui/lib/tool-state"
import { cn } from "@workspace/ui/lib/utils"
import {
  type ComponentType,
  createContext,
  type FC,
  type PropsWithChildren,
  type RefObject,
  useContext,
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

/** Ask answers and changes nothing; Act may start work once the owner says yes. */
export type ThreadMode = "ask" | "act"

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

/** What the conversation is about: the business, and where its site stands. */
export type ThreadContext = { name: string; status: string; live: boolean }

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
  context?: ThreadContext | null | undefined
  /** The mode chip renders only when both are given. */
  mode?: ThreadMode | undefined
  onModeChange?: ((mode: ThreadMode) => void) | undefined
  quickActions?: readonly ThreadQuickAction[] | undefined
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
  context,
  mode,
  onModeChange,
  quickActions,
}) => {
  const isEmpty = useAuiState((s) => !stored && isNewChatView(s))
  const settings = useMemo(
    () => ({
      placeholder,
      briefing,
      context,
      mode,
      onModeChange,
      quickActions,
    }),
    [placeholder, briefing, context, mode, onModeChange, quickActions]
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
  if (Number.isNaN(date.getTime())) return null
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
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

const ThreadSuggestions: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestions flex w-full flex-wrap items-center justify-center gap-2 px-4">
      <ThreadPrimitive.Suggestions>
        {() => <ThreadSuggestionItem />}
      </ThreadPrimitive.Suggestions>
    </div>
  )
}

const ThreadSuggestionItem: FC = () => {
  return (
    <div className="aui-thread-welcome-suggestion-display">
      <SuggestionPrimitive.Trigger
        send
        render={
          <Button
            variant="outline"
            className="aui-thread-welcome-suggestion h-auto gap-1.5 whitespace-nowrap py-1.5 font-normal"
          />
        }
      >
        <SuggestionPrimitive.Title className="aui-thread-welcome-suggestion-text-1" />
        <SuggestionPrimitive.Description className="aui-thread-welcome-suggestion-text-2 empty:hidden" />
      </SuggestionPrimitive.Trigger>
    </div>
  )
}

const Composer: FC<{ autoFocus: boolean }> = ({ autoFocus }) => {
  const { placeholder = "Send a message", context } = useContext(
    ThreadSettingsContext
  )
  const input = useRef<HTMLTextAreaElement>(null)
  return (
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      {/* A one-pixel ring on top of the border: the composer holds focus
          whenever the page is open, so a heavy ring would never go away. */}
      <div
        data-slot="aui_composer-shell"
        className="flex w-full cursor-text flex-col gap-2 rounded-(--composer-radius) border border-border bg-(--composer-bg) p-(--composer-padding) transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring"
      >
        {context ? <ContextChip {...context} /> : null}
        <ComposerPrimitive.Input
          ref={input}
          placeholder={placeholder}
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

// A long business name gives way before the site's state does: the state is
// the part that changes, so it is the part that must stay readable.
const ContextChip: FC<ThreadContext> = ({ name, status, live }) => (
  <p
    data-slot="aui_composer-context"
    className="flex min-w-0 max-w-full items-center self-start whitespace-nowrap rounded-full bg-muted px-2.5 py-0.5 text-[0.8125rem] text-muted-foreground"
  >
    <span
      aria-hidden
      className={cn(
        "me-1.5 size-1.5 shrink-0 rounded-full",
        live ? "bg-primary" : "bg-muted-foreground"
      )}
    />
    <span className="min-w-0 truncate font-medium text-foreground">{name}</span>
    <span className="shrink-0">, {status}</span>
  </p>
)

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

const MODES: Record<ThreadMode, { label: string; detail: string }> = {
  // Intent, not a guarantee: the chat sends the mode, and the backend that
  // enforces it comes later. The copy promises no more than that.
  ask: { label: "Ask", detail: "Questions only" },
  act: { label: "Act", detail: "Questions and changes" },
}

const ModeChip: FC = () => {
  const { mode, onModeChange } = useContext(ThreadSettingsContext)
  if (!mode || !onModeChange) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={`Mode, ${MODES[mode].label}`}
            className="aui-composer-mode rounded-full px-2.5 text-muted-foreground hover:text-foreground"
            size="sm"
            type="button"
            variant="ghost"
          />
        }
      >
        {MODES[mode].label}
        <CaretDownIcon aria-hidden className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64" side="top">
        <DropdownMenuRadioGroup
          onValueChange={(value) => onModeChange(value as ThreadMode)}
          value={mode}
        >
          {(Object.keys(MODES) as ThreadMode[]).map((value) => (
            <DropdownMenuRadioItem closeOnClick key={value} value={value}>
              <span className="flex flex-col py-1.5">
                <span className="font-medium">{MODES[value].label}</span>
                <span className="text-[0.8125rem] text-muted-foreground">
                  {MODES[value].detail}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const ComposerAction: FC<{ input: RefObject<HTMLTextAreaElement | null> }> = ({
  input,
}) => {
  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between gap-2">
      <div className="flex items-center gap-1">
        <QuickActions input={input} />
        <ModeChip />
      </div>
      <div className="flex items-center gap-1.5">
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate
              render={
                <TooltipIconButton
                  tooltip="Voice input"
                  side="bottom"
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="aui-composer-dictate size-8 rounded-full text-muted-foreground hover:text-foreground"
                  aria-label="Start voice input"
                />
              }
            >
              <MicrophoneIcon className="aui-composer-dictate-icon size-4" />
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation
              render={
                <TooltipIconButton
                  tooltip="Stop dictation"
                  side="bottom"
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="aui-composer-stop-dictation size-8 rounded-full text-destructive"
                  aria-label="Stop voice input"
                />
              }
            >
              <SquareIcon
                className="aui-composer-stop-dictation-icon size-3.5 animate-pulse motion-reduce:animate-none"
                weight="fill"
              />
            </ComposerPrimitive.StopDictation>
          </AuiIf>
        </AuiIf>
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
      className="relative -mb-7.5 pb-7.5 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
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
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
        {/* Copy has nothing to copy under a message of cards alone. */}
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
 * Copy and More only. No Reload and no Edit: the server writes every turn and
 * owns the history, so a regenerated or rewritten turn would only ever exist
 * on this screen.
 */
const AssistantActionBar: FC = () => {
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root col-start-3 row-start-2 -ms-1 flex gap-1 text-muted-foreground"
    >
      <ActionBarPrimitive.Copy render={<TooltipIconButton tooltip="Copy" />}>
        <AuiIf condition={(s) => s.message.isCopied}>
          <CheckIcon className="zoom-in-50 fade-in animate-in duration-200 ease-out motion-reduce:animate-none" />
        </AuiIf>
        <AuiIf condition={(s) => !s.message.isCopied}>
          <CopyIcon />
        </AuiIf>
      </ActionBarPrimitive.Copy>
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger
          render={
            <TooltipIconButton
              tooltip="More"
              className="data-[state=open]:bg-accent"
            />
          }
        >
          <DotsThreeIcon />
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 min-w-[8rem] overflow-hidden rounded-2xl border border-border bg-popover p-1.5 text-popover-foreground data-[state=closed]:animate-out data-[state=open]:animate-in motion-reduce:animate-none"
        >
          <ActionBarPrimitive.ExportMarkdown
            render={
              <ActionBarMorePrimitive.Item className="aui-action-bar-more-item flex cursor-pointer select-none items-center gap-2 rounded-2xl px-2.5 py-1.5 text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground" />
            }
          >
            <DownloadSimpleIcon className="size-4" />
            Export as Markdown
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  )
}

const UserMessage: FC = () => {
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      className="grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 [contain-intrinsic-size:auto_200px] [content-visibility:auto] [&:where(>*)]:col-start-2"
      data-role="user"
    >
      <div className="aui-user-message-content-wrapper relative col-start-2 min-w-0">
        <div className="aui-user-message-content wrap-break-word rounded-3xl bg-muted px-4 py-2 text-foreground empty:hidden">
          <MessagePrimitive.Parts />
        </div>
      </div>
    </MessagePrimitive.Root>
  )
}
