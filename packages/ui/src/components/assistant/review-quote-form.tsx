import { type ToolCallMessagePartComponent, useAui } from "@assistant-ui/react"
import {
  ArrowCounterClockwiseIcon,
  CalendarBlankIcon,
  CalendarDotsIcon,
  CaretCircleDownIcon,
  CheckSquareIcon,
  EnvelopeSimpleIcon,
  HashIcon,
  type Icon,
  ImageIcon,
  PhoneIcon,
  RadioButtonIcon,
  TextAlignLeftIcon,
  TextTIcon,
  TrashIcon,
} from "@phosphor-icons/react"
import {
  Docked,
  TrayFrame,
  TrayNote,
} from "@workspace/ui/components/assistant/question-tray"
import { Button } from "@workspace/ui/components/button"
import { Switch } from "@workspace/ui/components/switch"
import { ComposerInputContext } from "@workspace/ui/hooks/use-composer-input"
import {
  canDrop,
  confirmedFields,
  DROP_LIMIT,
  draftOf,
  dropField,
  QUOTE_TYPE_LABEL,
  type QuoteDraft,
  restoreField,
  setRequired,
} from "@workspace/ui/lib/quote-form"
import { reviewQuoteFormView } from "@workspace/ui/lib/tool-state"
import { useContext, useId, useState } from "react"

/**
 * The questions the assistant proposes for the site's quote request form,
 * from what the owner said they need to know to quote a job, in the question
 * tray. One row each: the question's type as an icon, the question, which
 * wraps, its type and options on a muted line, a Required switch and a
 * remove button that shows on hover or focus. The owner makes a question
 * optional or drops one, and confirms with "Use this form". Any other change
 * is typed in the composer, which "Make changes" starts for them, and the
 * message they send is the answer to this card (`changes`), not a new
 * subject. Nothing is sent until they press or send. Once answered it shows
 * nothing: the owner's reply after it says what they settled on.
 */

const TYPE_ICON: Record<QuoteDraft[number]["field"]["type"], Icon> = {
  text: TextTIcon,
  textarea: TextAlignLeftIcon,
  number: HashIcon,
  date: CalendarBlankIcon,
  datetime: CalendarDotsIcon,
  select: CaretCircleDownIcon,
  radio: RadioButtonIcon,
  checkbox: CheckSquareIcon,
  photos: ImageIcon,
  tel: PhoneIcon,
  email: EnvelopeSimpleIcon,
}

/** What "Make changes" starts the owner's message with. */
const CHANGES_START = "Change the form: "

/** One proposed question, kept or dropped. */
function Row({
  index,
  row,
  draft,
  onChange,
  limitId,
}: {
  index: number
  row: QuoteDraft[number]
  draft: QuoteDraft
  onChange: (next: QuoteDraft) => void
  limitId: string
}) {
  const { field } = row
  const name = field.label.trim() || `question ${index + 1}`
  if (row.dropped) {
    return (
      <li className="flex min-h-11 items-center gap-2 py-1">
        <span className="wrap-break-word min-w-0 flex-1 text-muted-foreground text-sm line-through">
          {name}
        </span>
        <Button
          aria-label={`Restore ${name}`}
          onClick={() => onChange(restoreField(draft, field.key))}
          size="sm"
          type="button"
          variant="ghost"
        >
          <ArrowCounterClockwiseIcon aria-hidden />
          Restore
        </Button>
      </li>
    )
  }
  const locked = !canDrop(draft)
  const TypeIcon = TYPE_ICON[field.type]
  // The type, then any options and hint, on one muted line.
  const detail = [
    QUOTE_TYPE_LABEL[field.type],
    field.options?.join(", "),
    field.hint,
  ]
    .filter(Boolean)
    .join(" · ")
  return (
    <li className="group flex items-center gap-3 py-2.5">
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
      >
        <TypeIcon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="wrap-break-word font-medium text-sm">{name}</span>
        <span className="truncate text-muted-foreground text-xs">{detail}</span>
      </div>
      {/* biome-ignore lint/a11y/noLabelWithoutControl: the switch is a span with a hidden input, which the rule cannot see */}
      <label className="flex shrink-0 cursor-pointer items-center gap-2 text-muted-foreground text-xs">
        Required
        <Switch
          aria-label={`${name}, required`}
          checked={field.required}
          onCheckedChange={(required) =>
            onChange(setRequired(draft, field.key, required))
          }
        />
      </label>
      {/* Hidden until the row is hovered or holds focus, unless the pointer is a finger. */}
      <Button
        aria-describedby={locked ? limitId : undefined}
        aria-disabled={locked || undefined}
        aria-label={`Remove ${name}`}
        className="pointer-fine:opacity-0 pointer-fine:focus-visible:opacity-100 pointer-fine:group-focus-within:opacity-100 pointer-fine:group-hover:opacity-100 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
        onClick={() => {
          if (!locked) onChange(dropField(draft, field.key))
        }}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <TrashIcon aria-hidden />
      </Button>
    </li>
  )
}

const ReviewQuoteForm: ToolCallMessagePartComponent = (props) => {
  const view = reviewQuoteFormView(props)
  const [draft, setDraft] = useState<QuoteDraft>(() =>
    view.state === "pending" ? draftOf(view.input.fields) : []
  )
  const [invalid, setInvalid] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const id = useId()
  const aui = useAui()
  const composer = useContext(ComposerInputContext)

  if (view.state === "answered") return null
  if (view.state !== "pending") {
    return (
      <TrayNote
        error={view.state === "error" ? view.message : null}
        name="review-quote-form"
      />
    )
  }

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
  // Starts the owner's message in the composer, where the change is typed;
  // a draft already there is theirs, so it is kept.
  const makeChanges = () => {
    const draftText = aui.thread().composer().getState().text
    if (!draftText.trim()) aui.thread().composer().setText(CHANGES_START)
    const input = composer.current
    if (!input) return
    input.focus()
    requestAnimationFrame(() =>
      input.setSelectionRange(input.value.length, input.value.length)
    )
  }

  return (
    <Docked name="review-quote-form">
      <TrayFrame
        collapsed={collapsed}
        hint="Name, email and phone are always asked."
        onCollapsedChange={setCollapsed}
        question="Questions for your quote form"
        skip={{ label: "Make changes", onSkip: makeChanges }}
        submit={{ label: "Use this form", onSubmit: confirm }}
      >
        <div className="flex min-w-0 flex-col rounded-xl border border-border bg-card px-3">
          <ol
            aria-label="Proposed questions"
            className="flex flex-col divide-y divide-border"
          >
            {draft.map((row, index) => (
              <Row
                draft={draft}
                index={index}
                key={row.field.key}
                limitId={`${id}-limit`}
                onChange={change}
                row={row}
              />
            ))}
          </ol>
        </div>
        {canDrop(draft) ? null : (
          <p className="px-1 text-muted-foreground text-xs" id={`${id}-limit`}>
            {DROP_LIMIT}
          </p>
        )}
        {invalid ? (
          <p className="px-1 text-[0.8125rem] text-destructive" role="alert">
            {invalid}
          </p>
        ) : null}
      </TrayFrame>
    </Docked>
  )
}
ReviewQuoteForm.displayName = "ReviewQuoteForm"

export { ReviewQuoteForm }
