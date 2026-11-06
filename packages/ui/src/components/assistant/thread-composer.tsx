import {
  AuiIf,
  ComposerPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react"
import {
  ArrowUpIcon,
  CheckCircleIcon,
  MicrophoneIcon,
  PlusIcon,
  SquareIcon,
  XIcon,
} from "@phosphor-icons/react"
import { RECAP_REPLY, SKIP_REPLY } from "@workspace/contracts"
import {
  waitsOnRecap,
  waitsToSkip,
} from "@workspace/ui/components/assistant/ask-open"
import { DecisionPills } from "@workspace/ui/components/assistant/decision-pills"
import {
  ReplyPill,
  ReplyPills,
} from "@workspace/ui/components/assistant/reply-pill"
import {
  ThreadSettingsContext,
  useSendable,
} from "@workspace/ui/components/assistant/thread-context"
import { TooltipIconButton } from "@workspace/ui/components/assistant/tooltip-icon-button"
import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { ComposerInputContext } from "@workspace/ui/hooks/use-composer-input"
import { waitsOnTray } from "@workspace/ui/lib/tool-state"
import { cn } from "@workspace/ui/lib/utils"
import {
  type FC,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"

/**
 * Skip this one, above the composer while an optional question asked in
 * words waits: a tap says so as the owner's message. A required one has none.
 * It leaves the focus where it is: the answer is typed.
 */
export const SkipThisOne: FC = () => {
  const aui = useAui()
  const sendable = useSendable()
  const waiting = useAuiState(
    (s) => !s.thread.isRunning && waitsToSkip(s.thread.messages.at(-1)?.parts)
  )
  if (!waiting || !sendable) return null
  return (
    <ReplyPills composer label="An optional question" takesFocus={false}>
      <ReplyPill
        data-slot="skip-this-one"
        onClick={() => aui.thread().append(SKIP_REPLY)}
      >
        {SKIP_REPLY}
      </ReplyPill>
    </ReplyPills>
  )
}

/**
 * Under the business recap: one pill confirms it as the owner's message; the
 * other starts a correction in the composer for the owner to finish, and
 * sends nothing.
 */
export const RecapReplies: FC = () => {
  const aui = useAui()
  const input = useContext(ComposerInputContext)
  const sendable = useSendable()
  const waiting = useAuiState(
    (s) => !s.thread.isRunning && waitsOnRecap(s.thread.messages.at(-1)?.parts)
  )
  if (!waiting || !sendable) return null
  return (
    <ReplyPills composer label="Have I got that right?">
      <ReplyPill onClick={() => aui.thread().append(RECAP_REPLY)}>
        {RECAP_REPLY}
      </ReplyPill>
      <ReplyPill
        onClick={() => {
          // A draft is the owner's words: keep it, never replace it.
          if (!aui.composer().getState().text.trim()) {
            aui.composer().setText("Change ")
          }
          const field = input.current
          field?.focus()
          field?.setSelectionRange(field.value.length, field.value.length)
        }}
      >
        Change something
      </ReplyPill>
    </ReplyPills>
  )
}

/** The newest decision's quick replies, once this conversation's history is in. */
export const LatestChoices: FC = () =>
  useSendable() ? <DecisionPills /> : null

/**
 * The composer. `expanded` is the new chat's: the field above, and the plus and
 * send under it. Once there is a conversation it is one compact row.
 */
export const Composer: FC<{ autoFocus: boolean; expanded: boolean }> = ({
  autoFocus,
  expanded,
}) => {
  const {
    placeholder = "Send a message",
    questionPlaceholder,
    mode,
    dictationNotice,
  } = useContext(ThreadSettingsContext)
  const input = useContext(ComposerInputContext)
  const aui = useAui()
  // A question or an approval waits in the tray, in any message since a
  // post may land after it: what the owner types instead is an ordinary
  // turn, and the placeholder says so.
  const asking = useAuiState((s) =>
    s.thread.messages.some(
      ({ parts }) =>
        waitsOnTray(parts) ||
        parts.some(
          (part) =>
            part.type === "tool-call" &&
            part.approval != null &&
            part.approval.approved === undefined
        )
    )
  )
  // Disabled, not only kept from sending: words typed into the placeholder
  // thread would stay behind with it when the stored one replaces it. The
  // input takes focus once it is enabled.
  const sendable = useSendable()
  useEffect(() => {
    if (mode) input.current?.focus()
  }, [mode, input])
  useTypeToComposer(input)
  const hold = useHoldToDictate()
  const dictating = useAuiState((s) => s.composer.dictation != null)
  const hearing = useAuiState((s) => !!s.composer.dictation?.transcript)
  return (
    <ComposerPrimitive.Root
      className={cn(
        "aui-composer-root flex w-full flex-col",
        // Docked, it is the footer's last box, so sticking never moves it.
        // Chrome then counts a tray docking above it as the footer's sticky
        // offset, not a layout shift of the composer.
        expanded ? "relative" : "sticky bottom-0"
      )}
    >
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
        <div
          className={cn(
            "grid min-w-0",
            expanded ? "order-first basis-full" : "flex-1"
          )}
        >
          <ComposerPrimitive.Input
            ref={input}
            placeholder={
              dictating
                ? "Listening…"
                : (mode?.placeholder ??
                  (asking && questionPlaceholder
                    ? questionPlaceholder
                    : placeholder))
            }
            className={cn(
              FIELD,
              "aui-composer-input resize-none bg-transparent text-chat-foreground caret-primary outline-none placeholder:text-muted-foreground/60",
              expanded ? "min-h-16" : "min-h-9",
              hearing && "text-transparent"
            )}
            rows={1}
            autoFocus={autoFocus}
            disabled={!sendable}
            enterKeyHint="send"
            aria-label="Message input"
            // assistant-ui sends nothing on Enter while a reply runs, but lets
            // the key type a new line into what the owner waits to send.
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing &&
                aui.thread().getState().isRunning
              )
                e.preventDefault()
              hold.onKeyDown(e)
            }}
            onKeyUp={hold.onKeyUp}
            onBlur={hold.onBlur}
          />
          <HeardSoFar input={input} />
        </div>
        <ComposerSend expanded={expanded} />
      </div>
      {/* Always in the page, so a notice that appears in it is read out. */}
      <p
        aria-live="polite"
        className={cn(
          "px-3 pt-2 text-muted-foreground text-sm empty:hidden",
          !dictationNotice && "sr-only"
        )}
        data-slot="aui_dictation-notice"
      >
        {dictationNotice ?? (dictating ? "Listening" : null)}
      </p>
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
      typeInto(field, event.key)
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [input])
}

/** Types `text` at the caret: insertText keeps the editor's undo and fires the input event React reads. */
function typeInto(field: HTMLTextAreaElement, text: string) {
  if (document.execCommand?.("insertText", false, text)) return
  field.setRangeText(text, field.selectionStart, field.selectionEnd, "end")
  field.dispatchEvent(new Event("input", { bubbles: true }))
}

/** How long Space is held in the composer before it dictates instead of typing. */
const HOLD_TO_DICTATE_MS = 300

/** Whether the browser has already granted the microphone; false where it cannot say. */
function useMicrophoneGranted() {
  const [granted, setGranted] = useState(false)
  useEffect(() => {
    let status: PermissionStatus | undefined
    let gone = false
    const read = () => setGranted(status?.state === "granted")
    navigator.permissions?.query({ name: "microphone" }).then(
      (found) => {
        if (gone) return
        status = found
        read()
        found.addEventListener("change", read)
      },
      () => undefined
    )
    return () => {
      gone = true
      status?.removeEventListener("change", read)
    }
  }, [])
  return granted
}

/**
 * Hold Space to dictate. In the composer, with the caret at the start of a
 * word and nothing selected, Space held past `HOLD_TO_DICTATE_MS` starts the
 * composer's dictation, and letting go stops it as Done does, so
 * the words are tidied the same way. A shorter press types its space as it
 * is let go. Only once the browser has granted the microphone, so a first
 * use goes through the button and its prompt, and never while an input
 * method is composing (after hermes-agent apps/desktop/src/lib/keybinds/combo.ts, MIT).
 */
function useHoldToDictate() {
  const aui = useAui()
  const granted = useMicrophoneGranted()
  const held = useRef<"pending" | "dictating" | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const end = (field: HTMLTextAreaElement, typed: boolean) => {
    clearTimeout(timer.current)
    const was = held.current
    held.current = null
    if (was === "dictating") aui.composer().stopDictation()
    else if (was === "pending" && typed) typeInto(field, " ")
  }
  return {
    onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== " ") return
      if (held.current) return event.preventDefault()
      const field = event.currentTarget
      const before = field.value[field.selectionStart - 1]
      if (
        !granted ||
        event.repeat ||
        event.nativeEvent.isComposing ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        field.selectionStart !== field.selectionEnd ||
        (before !== undefined && !/\s/.test(before)) ||
        !aui.thread().getState().capabilities.dictation ||
        aui.composer().getState().dictation != null
      )
        return
      event.preventDefault()
      held.current = "pending"
      timer.current = setTimeout(() => {
        held.current = "dictating"
        aui.composer().startDictation()
      }, HOLD_TO_DICTATE_MS)
    },
    onKeyUp: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === " ") end(event.currentTarget, true)
    },
    onBlur: (event: ReactFocusEvent<HTMLTextAreaElement>) =>
      end(event.currentTarget, false),
  }
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

/** The field's box, shared by the input and the words drawn over it. */
const FIELD = "max-h-48 min-w-0 px-1.5 py-1.25 text-chat [grid-area:1/1]"

/**
 * While a phrase is still being recognised, the field's own text is hidden
 * and drawn again over it, the phrase muted and italic: a textarea cannot
 * style part of its text. assistant-ui keeps that phrase at the end of the
 * text until it settles.
 */
const HeardSoFar: FC<{ input: RefObject<HTMLTextAreaElement | null> }> = ({
  input,
}) => {
  const text = useAuiState((s) => s.composer.text)
  const phrase = useAuiState((s) => s.composer.dictation?.transcript)
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (box.current && input.current) {
      box.current.scrollTop = input.current.scrollTop
    }
  })
  if (!phrase || !text.endsWith(phrase)) return null
  return (
    <div
      aria-hidden
      className={cn(
        FIELD,
        "pointer-events-none overflow-hidden whitespace-pre-wrap break-words text-chat-foreground"
      )}
      data-slot="aui_dictation-heard"
      ref={box}
    >
      {text.slice(0, -phrase.length)}
      <ComposerPrimitive.DictationTranscript className="text-muted-foreground italic" />
    </div>
  )
}

/** The bars' heights at full level, centre highest (after hermes-agent voice-activity.tsx, MIT). */
const BARS = [0.5, 0.78, 1, 0.78, 0.5]

/**
 * The microphone's level as a row of dots that rise into bars, written
 * straight to a CSS variable so a level redraws no React tree. Still for
 * anyone who asked for less motion.
 */
const LevelMeter: FC = () => {
  const { dictation } = useContext(ThreadSettingsContext)
  const meter = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!dictation || matchMedia("(prefers-reduced-motion: reduce)").matches)
      return
    return dictation.onLevel((level) =>
      meter.current?.style.setProperty("--level", String(level))
    )
  }, [dictation])
  return (
    <span
      aria-hidden
      className="flex h-9 items-center gap-1 px-2 text-foreground"
      data-slot="aui_dictation-level"
      ref={meter}
    >
      {BARS.map((weight) => (
        <span
          className="w-1 rounded-full bg-current opacity-[calc(0.3+var(--level,0)*0.7)] transition-[height,opacity] duration-100 ease-out"
          key={weight}
          style={{ height: `calc(4px + var(--level, 0) * ${weight * 18}px)` }}
        />
      ))}
    </span>
  )
}

/**
 * Listening, in place of the mic and send: the level, × to drop what this
 * dictation wrote and keep what was typed before it, and ✓ to keep the
 * words, which the tidy pass then cleans. Neither sends.
 */
const ComposerListening: FC = () => {
  const aui = useAui()
  const { dictation } = useContext(ThreadSettingsContext)
  const [before] = useState(() => aui.composer().getState().text)
  return (
    <>
      <LevelMeter />
      <TooltipIconButton
        aria-label="Cancel dictation"
        className="text-muted-foreground"
        data-slot="aui_dictation-cancel"
        onClick={() => {
          dictation?.cancel()
          aui.composer().setText(before)
        }}
        side="bottom"
        size="icon"
        tooltip="Cancel dictation"
        type="button"
        variant="ghost"
      >
        <XIcon aria-hidden className="size-4" weight="bold" />
      </TooltipIconButton>
      <ComposerPrimitive.StopDictation
        render={
          <TooltipIconButton
            aria-label="Done"
            data-slot="aui_dictation-done"
            side="bottom"
            size="icon"
            tooltip="Done"
            type="button"
            variant="default"
          />
        }
      >
        <CheckCircleIcon aria-hidden className="size-4.5" weight="bold" />
      </ComposerPrimitive.StopDictation>
    </>
  )
}

const ComposerSend: FC<{ expanded: boolean }> = ({ expanded }) => {
  const dictating = useAuiState((s) => s.composer.dictation != null)
  return (
    // In the expanded composer the buttons sit under the field, send at the right.
    <div className={cn("flex items-center gap-1", expanded && "ms-auto")}>
      {dictating ? <ComposerListening /> : <ComposerSendButtons />}
    </div>
  )
}

/**
 * The mic, then send or stop. The mic starts a dictation; holding Space in
 * the field does too (`useHoldToDictate`). Without a dictation adapter it is
 * disabled.
 */
const ComposerSendButtons: FC = () => {
  const sendable = useSendable()
  return (
    <>
      <ComposerPrimitive.Dictate
        disabled={!sendable}
        render={
          <TooltipIconButton
            aria-label="Dictate"
            className="aui-composer-dictate text-muted-foreground"
            side="bottom"
            size="icon"
            tooltip="Dictate, or hold Space to talk"
            type="button"
            variant="ghost"
          />
        }
      >
        <MicrophoneIcon aria-hidden className="size-4" weight="bold" />
      </ComposerPrimitive.Dictate>
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
    </>
  )
}
