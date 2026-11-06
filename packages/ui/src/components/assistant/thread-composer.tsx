import {
  AuiIf,
  ComposerPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react"
import {
  ArrowUpIcon,
  MicrophoneIcon,
  PlusIcon,
  SquareIcon,
  StopIcon,
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
        <ComposerPrimitive.Input
          ref={input}
          placeholder={
            mode?.placeholder ??
            (asking && questionPlaceholder ? questionPlaceholder : placeholder)
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
        <ComposerSend expanded={expanded} />
      </div>
      {/* Always in the page, so a notice that appears in it is read out. */}
      <p
        aria-live="polite"
        className="px-3 pt-2 text-muted-foreground text-sm empty:hidden"
        data-slot="aui_dictation-notice"
      >
        {dictationNotice}
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
 * composer's dictation, and letting go stops it as the Stop button does, so
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

/**
 * Voice dictation: the words land in the field as they are recognised, each
 * partial replacing the last, and the owner can type among them. Tap again to
 * stop, or hold Space in the field instead (`useHoldToDictate`). Without a
 * dictation adapter the mic is disabled.
 */
const ComposerDictate: FC = () => {
  const sendable = useSendable()
  const button = "aui-composer-dictate rounded-full"
  return (
    <>
      <AuiIf condition={(s) => s.composer.dictation == null}>
        <ComposerPrimitive.Dictate
          disabled={!sendable}
          render={
            <TooltipIconButton
              aria-label="Dictate"
              className={cn(button, "text-muted-foreground")}
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
      </AuiIf>
      <AuiIf condition={(s) => s.composer.dictation != null}>
        <ComposerPrimitive.StopDictation
          render={
            <TooltipIconButton
              aria-label="Stop dictating"
              className={cn(
                button,
                "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
              )}
              side="bottom"
              size="icon"
              tooltip="Stop dictating"
              type="button"
              variant="ghost"
            />
          }
        >
          <StopIcon
            aria-hidden
            className="size-4 motion-safe:animate-pulse"
            weight="fill"
          />
        </ComposerPrimitive.StopDictation>
      </AuiIf>
    </>
  )
}

const ComposerSend: FC<{ expanded: boolean }> = ({ expanded }) => {
  const sendable = useSendable()
  return (
    // In the expanded composer the buttons sit under the field, send at the right.
    <div className={cn("flex gap-1", expanded && "ms-auto")}>
      <ComposerDictate />
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
