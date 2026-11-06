import {
  ActionBarPrimitive,
  type AssistantState,
  AuiIf,
  ErrorPrimitive,
  type GroupByContext,
  groupPartByType,
  MessagePartPrimitive,
  MessagePrimitive,
  type PartState,
  TextMessagePartProvider,
  useAui,
  useAuiState,
} from "@assistant-ui/react"
import { ThumbsDownIcon, ThumbsUpIcon } from "@phosphor-icons/react"
import { AskDesignInput, AskDesignOutput } from "@workspace/contracts"
import { COS_QUIET } from "@workspace/ui/components/assistant/cos-tools"
import { DesignReply } from "@workspace/ui/components/assistant/design-reply"
import {
  MarkdownText,
  READING_PACE,
} from "@workspace/ui/components/assistant/markdown-text"
import {
  ReasoningGroup as DefaultReasoningGroup,
  Reasoning,
} from "@workspace/ui/components/assistant/reasoning"
import {
  ThreadComponentsContext,
  ThreadRevealContext,
  ThreadSettingsContext,
} from "@workspace/ui/components/assistant/thread-context"
import {
  createdAt,
  labelled,
  sentAt,
  UpdateLabel,
} from "@workspace/ui/components/assistant/thread-labels"
import { ToolFallback } from "@workspace/ui/components/assistant/tool-fallback"
import { ToolGroup as DefaultToolGroup } from "@workspace/ui/components/assistant/tool-group"
import { TooltipIconButton } from "@workspace/ui/components/assistant/tooltip-icon-button"
import { Button } from "@workspace/ui/components/button"
import {
  ReplyStatus,
  StateIcon,
  StatusLine,
} from "@workspace/ui/components/status-line"
import {
  useOnboardingWait,
  useStatusTurn,
} from "@workspace/ui/hooks/use-onboarding-status"
import { waitingLine, writingBack } from "@workspace/ui/lib/activity-copy"
import { formatTime } from "@workspace/ui/lib/format"
import {
  designText,
  SESSION_ENDED,
  SKIPPED,
  showsProgress,
} from "@workspace/ui/lib/tool-state"
import { cn } from "@workspace/ui/lib/utils"
import {
  type FC,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useState,
} from "react"

const UNGROUPED = [] as const

const groupByType = groupPartByType({
  reasoning: ["group-chainOfThought", "group-reasoning"],
  "tool-call": ["group-chainOfThought", "group-tool"],
  "standalone-tool-call": [],
})

/**
 * Where each part sits in the transcript. Everything follows the registry's
 * grouping, where a toolkit card is standalone, except a tool call that
 * carries an approval or waits on the owner, which stays ungrouped for the
 * whole of its life: an approval folded into a collapsed disclosure is one
 * the owner has to go looking for, and the answer has to stay as visible as
 * the question was.
 */
const groupThreadParts = (part: PartState, context?: GroupByContext) =>
  part.type === "tool-call" &&
  (part.approval != null || part.status?.type === "requires-action")
    ? UNGROUPED
    : groupByType(part, context)

const MessageError: FC = () => {
  const { onRetry } = useContext(ThreadSettingsContext)
  const ended = useAuiState(
    (s) =>
      s.message.status?.type === "incomplete" &&
      s.message.status.error === SESSION_ENDED
  )
  // Only a reply the app marked as one it can send again, and only the last.
  const retryable = useAuiState(
    (s) => s.message.isLast && s.message.metadata.custom?.retry === true
  )
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-destructive bg-destructive/10 p-3 text-destructive text-sm dark:bg-destructive/5">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2 min-w-0 flex-1" />
        {ended ? (
          <a
            className="font-medium text-foreground underline underline-offset-4"
            href={`/sign-in?returnTo=${encodeURIComponent(window.location.pathname)}`}
          >
            Sign in again
          </a>
        ) : onRetry && retryable ? (
          <Button onClick={onRetry} size="sm" type="button" variant="outline">
            Retry
          </Button>
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
  const { status, seconds } = useOnboardingWait()
  const turn = useStatusTurn()
  const toolsRan = useAuiState((s) =>
    s.message.parts.some((part) => part.type === "tool-call")
  )
  // Seeded by this turn and the ones before, so the words vary between
  // turns and never read as the last turn's. Joined, so the read is stable.
  const seed = useAuiState((s) => s.message.id)
  const earlier = useAuiState((s) => {
    const all = s.thread.messages
    const at = all.findIndex((m) => m.id === s.message.id)
    return all
      .slice(0, at)
      .filter((m) => m.role === "assistant")
      .map((m) => m.id)
      .join(" ")
  })
  if (shown) return null
  const ctx = { seed, earlier: earlier ? earlier.split(" ") : [], assistant }
  const { label } =
    !status && (immediate || toolsRan)
      ? { label: writingBack(ctx) }
      : waitingLine(status, seconds, ctx)
  return (
    <span data-slot="aui_assistant-message-indicator">
      {immediate ? (
        <StatusLine delay={0} label={label} />
      ) : (
        <ReplyStatus
          label={label}
          lines={turn.lines}
          since={turn.since ?? undefined}
        />
      )}
    </span>
  )
}

/** How long a played-in message shows the typing dot, then plays in its words. */
const REVEAL_TYPING_MS = 700
const REVEAL_TYPING_REDUCED_MS = 300

type Reveal =
  /** Not played in: the message as it stands. */
  | { phase: "still" }
  | { phase: "typing" }
  | { phase: "writing"; text: string }
  /** Played in, and done: the whole message, its cards fading in. */
  | { phase: "played" }

/**
 * Plays in the opening message, alone in the thread, the first time this
 * browser shows it: the typing dot, then its words at the reading pace every
 * reply streams at, which shows them all within `READING_PACE.drainMs`.
 * Decided once, when the message first renders, so a history that loads
 * later never replays it. The owner typing or sending ends it at once, and
 * less motion skips the words.
 */
const useReveal = (): Reveal => {
  const reveal = useContext(ThreadRevealContext)
  const aui = useAui()
  const [text] = useState(() => {
    const message = aui.message().getState()
    const opening =
      message.role === "assistant" &&
      message.index === 0 &&
      aui.thread().getState().messages.length === 1
    if (!reveal || !opening || !reveal.unseen(message.id, createdAt(message)))
      return null
    return message.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("\n\n")
  })
  const id = useAuiState((s) => s.message.id)
  const [writing, setWriting] = useState(false)
  const [over, setOver] = useState(false)
  const interrupted = useAuiState(
    (s) => !s.thread.composer.isEmpty || s.thread.messages.length > 1
  )
  useEffect(() => {
    if (interrupted) setOver(true)
  }, [interrupted])
  useEffect(() => {
    if (text === null) return
    reveal?.seen(id)
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches
    let timer = setTimeout(
      () => {
        if (reduced) return setOver(true)
        setWriting(true)
        timer = setTimeout(() => setOver(true), READING_PACE.drainMs)
      },
      reduced ? REVEAL_TYPING_REDUCED_MS : REVEAL_TYPING_MS
    )
    return () => clearTimeout(timer)
  }, [text, reveal, id])
  if (text === null) return { phase: "still" }
  if (over) return { phase: "played" }
  if (!writing) return { phase: "typing" }
  return { phase: "writing", text }
}

export const AssistantMessage: FC = () => {
  const {
    ToolFallback: ToolFallbackComponent = ToolFallback,
    ToolGroup = DefaultToolGroup,
    ReasoningGroup = DefaultReasoningGroup,
  } = useContext(ThreadComponentsContext)
  const ACTION_BAR_PT = "pt-1.5"
  // Keep the action bar inside the contained root's paint box, then cancel its reserved space in flow.
  const ACTION_BAR_HEIGHT = `min-h-7.5 ${ACTION_BAR_PT}`

  const reveal = useReveal()
  const posted = useAuiState((s) => labelled(s.message))
  const running = useAuiState((s) => s.message.status?.type === "running")
  const writing =
    running || reveal.phase === "typing" || reveal.phase === "writing"
  // A reply that ended with nothing in it and no error to show is no row at
  // all, not a time on its own.
  const blank = useAuiState(
    (s) =>
      s.message.status?.type !== "running" &&
      !(
        s.message.status?.type === "incomplete" &&
        s.message.status.reason === "error"
      ) &&
      s.message.parts.length === 0
  )
  if (blank && reveal.phase === "still") return null

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="group/message relative -mb-7.5 ps-2 pb-7.5 [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <div className="min-w-0">
        {posted ? <UpdateLabel kind={posted} /> : null}
        <div
          data-slot="aui_assistant-message-content"
          // What follows words still typing in waits for them (the markdown
          // reads running until its reveal catches up), so a card under them
          // shows where it settles instead of sliding down as they grow.
          // Words in a later step, such as the web address offer after the
          // build line, open a paragraph of their own.
          className="wrap-break-word pe-2 text-chat text-chat-foreground [&>.aui-md[data-status=running]~*]:invisible [&>.aui-md~.aui-md]:mt-4"
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
            shows (or counts as moving) until the reply is done: streamed,
            and its words revealed, which run on after the stream and can
            wrap to another line on a phone. */}
        <div
          data-slot="aui_assistant-message-footer"
          className={cn(
            "flex items-center gap-2 group-has-[.aui-md[data-status=running]]/message:invisible",
            ACTION_BAR_HEIGHT,
            writing && "invisible"
          )}
        >
          {/* A posted update says its time once, in its label. */}
          {posted ? null : <MessageTime />}
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

const MessageTime: FC = () => {
  const at = useAuiState((s) => sentAt(s.message))
  return (
    <time
      className="text-[0.6875rem] text-muted-foreground tabular-nums"
      dateTime={at}
    >
      {formatTime(new Date(at))}
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

const DELIVERY = { sent: "Sent", delivered: "Delivered", seen: "Seen" }

const DeliveryTick: FC = () => {
  const delivery = useAuiState(deliveryOf)
  return (
    <span data-slot="aui_user-message-delivery" data-state={delivery}>
      <StateIcon state={delivery} />
      <span className="sr-only">{DELIVERY[delivery]}</span>
    </span>
  )
}

const UserText: FC = () => (
  <p className="whitespace-pre-line">
    <MessagePartPrimitive.Text />
  </p>
)

const USER_PARTS = { Text: UserText }

/**
 * The design tray this message is the owner's reply to, when it reads as
 * that tray's answers: the bubble then draws them as chips.
 */
function useDesignReply() {
  const text = useAuiState((s) => {
    const [only, ...rest] = s.message.parts
    return rest.length === 0 && only?.type === "text" ? only.text : null
  })
  const card = useAuiState((s) => {
    const at = s.thread.messages.findIndex((m) => m.id === s.message.id)
    return [...(s.thread.messages[at - 1]?.parts ?? [])]
      .reverse()
      .find(
        (part) =>
          part.type === "tool-call" &&
          part.toolName === "ask_design" &&
          part.result !== undefined
      )
  })
  if (text === null || card?.type !== "tool-call") return null
  const input = AskDesignInput.safeParse(card.args)
  const output = AskDesignOutput.safeParse(card.result)
  return input.success &&
    output.success &&
    !output.data.skip_all &&
    designText(input.data, output.data) === text
    ? { input: input.data, output: output.data }
    : null
}

/** A typed message of more lines than this shows only the first few behind Show more. */
const LONG_AFTER_LINES = 8
const COLLAPSED_LINES = 6

/**
 * Whether a message's text runs past `LONG_AFTER_LINES`, counted where it
 * sits so a narrower window counts again, and whether the owner has opened
 * it. `clip` goes on the element that holds the text.
 */
function useLongText() {
  const [clip, setClip] = useState<HTMLElement | null>(null)
  const [long, setLong] = useState(false)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    if (!clip) return
    const measure = () => {
      const line = Number.parseFloat(getComputedStyle(clip).lineHeight)
      setLong(line > 0 && clip.scrollHeight > line * LONG_AFTER_LINES)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(clip)
    return () => observer.disconnect()
  }, [clip])
  return { clip: setClip, long, open, toggle: () => setOpen((was) => !was) }
}

export const UserMessage: FC = () => {
  // A skipped question's reply is a note in the thread, not words the owner said.
  const skipped = useAuiState((s) => {
    const [only, ...rest] = s.message.parts
    return rest.length === 0 && only?.type === "text" && only.text === SKIPPED
  })
  const design = useDesignReply()
  const text = useLongText()
  const textId = useId()
  const collapsed = text.long && !text.open
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
            skipped ? "text-muted-foreground" : "text-chat-foreground",
            design && "p-2 sm:p-2"
          )}
        >
          {design ? (
            <DesignReply {...design} />
          ) : (
            <div
              data-slot="aui_user-message-text"
              id={textId}
              ref={text.clip}
              className="relative overflow-hidden"
              style={
                collapsed ? { maxHeight: `${COLLAPSED_LINES}lh` } : undefined
              }
            >
              <MessagePrimitive.Parts components={USER_PARTS} />
              {collapsed && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-linear-to-t from-muted to-transparent"
                />
              )}
            </div>
          )}
        </div>
        <div className="mt-1 flex items-center">
          {text.long && (
            <Button
              aria-controls={textId}
              aria-expanded={text.open}
              className="-ms-1 text-muted-foreground"
              onClick={text.toggle}
              size="xs"
              type="button"
              variant="link"
            >
              {text.open ? "Show less" : "Show more"}
            </Button>
          )}
          <span
            data-slot="aui_user-message-meta"
            className="ms-auto me-2 flex items-center gap-1 text-muted-foreground"
          >
            <MessageTime />
            <DeliveryTick />
          </span>
        </div>
      </div>
    </MessagePrimitive.Root>
  )
}
