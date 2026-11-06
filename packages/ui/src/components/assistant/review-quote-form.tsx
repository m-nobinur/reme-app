import type { ToolCallMessagePartComponent } from "@assistant-ui/react"
import {
  CalendarBlankIcon,
  CalendarDotsIcon,
  CheckSquareIcon,
  EnvelopeSimpleIcon,
  HashIcon,
  type Icon,
  ImageIcon,
  PhoneIcon,
  RadioButtonIcon,
  TextAlignLeftIcon,
  TextTIcon,
  XIcon,
} from "@phosphor-icons/react"
import {
  TrayNote,
  useTabDraft,
} from "@workspace/ui/components/assistant/question-tray"
import { QuoteFormPreview } from "@workspace/ui/components/assistant/quote-form-preview"
import { Button } from "@workspace/ui/components/button"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { Hint } from "@workspace/ui/components/tooltip"
import { useRevealWaiting } from "@workspace/ui/hooks/use-reveal-waiting"
import {
  canDrop,
  confirmedFields,
  DROP_LIMIT,
  draftOf,
  dropField,
  keptFields,
  type QuoteDraft,
  setRequired,
  shownQuote,
} from "@workspace/ui/lib/quote-form"
import { reviewQuoteFormView } from "@workspace/ui/lib/tool-state"
import { useEffect, useLayoutEffect, useRef, useState } from "react"

/**
 * What the owner needs to know before a quote, as the assistant proposes it
 * from their answer: one pill per question in the transcript, its type as an
 * icon, then a star when the question is required or "optional" when it is
 * not. A click on either switches it, and a pill's remove button shows on
 * hover or focus. A choice question's label opens its options and hint, and
 * a label cut short shows whole in a tooltip. "Preview form" opens the form as
 * customers see it, with "Looks good" in its footer. Anything else is said in the chat: words typed while the
 * pills wait answer them (`quoteChanges` carries the pills as the owner left
 * them), and "Looks good" confirms. Answered, it draws nothing: the reply
 * says what was saved, or the next proposal shows what changed.
 */

const TYPE_ICON: Record<QuoteDraft[number]["field"]["type"], Icon> = {
  text: TextTIcon,
  textarea: TextAlignLeftIcon,
  number: HashIcon,
  date: CalendarBlankIcon,
  datetime: CalendarDotsIcon,
  // One choice, however the form draws it.
  select: RadioButtonIcon,
  radio: RadioButtonIcon,
  checkbox: CheckSquareIcon,
  photos: ImageIcon,
  tel: PhoneIcon,
  email: EnvelopeSimpleIcon,
}

/** The star a required question carries, or the word for an optional one. */
function Mark({ required }: { required: boolean }) {
  return required ? (
    <span
      aria-hidden
      className="font-semibold text-base text-primary leading-none"
    >
      *
    </span>
  ) : (
    <span aria-hidden className="text-muted-foreground text-xs">
      optional
    </span>
  )
}

/** A pill's label, cut to fit, whole in a tooltip when it is cut. */
function Label({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [cut, setCut] = useState(false)
  useLayoutEffect(() => {
    const label = ref.current
    if (label) setCut(label.scrollWidth > label.clientWidth)
  }, [])
  const shown = (
    <span className="max-w-56 truncate" ref={ref}>
      {text}
    </span>
  )
  return cut ? (
    <Hint label={text} side="top">
      {shown}
    </Hint>
  ) : (
    shown
  )
}

/** A choice question's options and hint, from a tap on its label. */
function Choices({
  field,
  icon: TypeIcon,
}: {
  field: QuoteDraft[number]["field"]
  icon: Icon
}) {
  const several = field.type === "checkbox"
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`${field.label}, ${several ? "several choices" : "one choice"}: show the options`}
        className="-ms-1 flex min-w-0 items-center gap-1.5 rounded-full ps-1 pe-1 outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring"
      >
        <TypeIcon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <Label text={field.label} />
      </PopoverTrigger>
      <PopoverContent>
        <PopoverTitle>{field.label}</PopoverTitle>
        {field.hint ? (
          <PopoverDescription>{field.hint}</PopoverDescription>
        ) : null}
        <ul className="flex flex-col gap-1.5 text-sm">
          {field.options?.map((option) => (
            <li className="flex items-center gap-2" key={option}>
              <TypeIcon
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground"
              />
              {option}
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground text-xs">
          {several ? "Customers can pick several." : "Customers pick one."}
        </p>
      </PopoverContent>
    </Popover>
  )
}

/** One proposed question. */
function Pill({
  row,
  draft,
  onChange,
}: {
  row: QuoteDraft[number]
  draft: QuoteDraft
  onChange: (next: QuoteDraft) => void
}) {
  const { field } = row
  const TypeIcon = TYPE_ICON[field.type]
  const locked = !canDrop(draft)
  return (
    <li className="group inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border border-border bg-card ps-2.5 pe-1.5 text-sm">
      {field.options ? (
        <Choices field={field} icon={TypeIcon} />
      ) : (
        <>
          <TypeIcon
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <Label text={field.label} />
        </>
      )}
      <Hint
        detail={
          field.required
            ? "Customers must answer this. Click to make it optional."
            : "Customers can leave this out. Click to make it required."
        }
        label={field.required ? "Required" : "Optional"}
        side="top"
      >
        <button
          // Names the state it shows, "optional" or the asterisk, as its text.
          aria-label={`${field.label}, ${field.required ? "required" : "optional"}`}
          className="-ms-1 flex h-6 min-w-6 items-center justify-center rounded-full px-1 outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() =>
            onChange(setRequired(draft, field.key, !field.required))
          }
          type="button"
        >
          <Mark required={field.required} />
        </button>
      </Hint>
      {/* Hidden until the pill is hovered or holds focus, unless the pointer is a finger. */}
      <Hint label={locked ? DROP_LIMIT : "Remove"} side="top">
        <button
          aria-disabled={locked || undefined}
          aria-label={`Remove ${field.label}`}
          className="-ms-1.5 flex size-5 items-center justify-center rounded-full text-muted-foreground pointer-fine:opacity-0 outline-none hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring pointer-fine:group-focus-within:opacity-100 pointer-fine:group-hover:opacity-100 aria-disabled:cursor-not-allowed aria-disabled:hover:bg-transparent"
          onClick={() => {
            if (!locked) onChange(dropField(draft, field.key))
          }}
          type="button"
        >
          <XIcon aria-hidden className="size-3" />
        </button>
      </Hint>
    </li>
  )
}

const ReviewQuoteForm: ToolCallMessagePartComponent = (props) => {
  const view = reviewQuoteFormView(props)
  const { toolCallId } = props
  const { draft, keep: setDraft } = useTabDraft<QuoteDraft>(
    `quote:${toolCallId}`,
    view.state === "pending" ? draftOf(view.input.fields) : []
  )
  const [invalid, setInvalid] = useState<string | null>(null)
  const pending = view.state === "pending"
  const running = useRevealWaiting(pending)

  // Words typed over the pills carry them as the owner left them.
  useEffect(() => {
    if (!pending) return
    shownQuote.set(toolCallId, keptFields(draft))
    return () => {
      shownQuote.delete(toolCallId)
    }
  }, [pending, toolCallId, draft])

  if (!pending) {
    return (
      <TrayNote
        error={view.state === "error" ? view.message : null}
        name="review-quote-form"
      />
    )
  }
  // Never mid-stream: the pills show once the message is whole.
  if (running) return null

  const change = (next: QuoteDraft) => {
    setInvalid(null)
    setDraft(next)
  }
  const confirm = () => {
    const result = confirmedFields(draft)
    if ("problem" in result) {
      setInvalid(result.problem)
      return
    }
    props.addResult({ answer: "confirmed", fields: result.fields })
  }

  return (
    <div
      className="motion-safe:fade-in-0 flex flex-col gap-2.5 pt-3 duration-enter ease-standard motion-safe:animate-in"
      data-slot="review-quote-form"
    >
      <ul
        aria-label="What I'll ask customers"
        className="flex flex-wrap gap-1.5"
      >
        {draft
          .filter((row) => !row.dropped)
          .map((row) => (
            <Pill
              draft={draft}
              key={row.field.key}
              onChange={change}
              row={row}
            />
          ))}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
          <span className="inline-flex items-center gap-1">
            <Mark required /> Required
          </span>
          <span>Name and email are always asked, phone is optional.</span>
        </p>
        <QuoteFormPreview fields={keptFields(draft)} onConfirm={confirm} />
      </div>
      {invalid ? (
        <p className="text-[0.8125rem] text-destructive" role="alert">
          {invalid}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={confirm} size="sm" type="button">
          Looks good
        </Button>
        <span className="text-muted-foreground text-xs">
          or tell me what to change
        </span>
      </div>
    </div>
  )
}
ReviewQuoteForm.displayName = "ReviewQuoteForm"

export { ReviewQuoteForm }
