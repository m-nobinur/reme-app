import type { ToolCallMessagePartComponent } from "@assistant-ui/react"
import { ArrowCounterClockwiseIcon, TrashIcon } from "@phosphor-icons/react"
import {
  Docked,
  TrayFrame,
  TrayNote,
} from "@workspace/ui/components/assistant/question-tray"
import { Button } from "@workspace/ui/components/button"
import { Switch } from "@workspace/ui/components/switch"
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
import { useId, useState } from "react"

/**
 * The questions the assistant proposes for the site's quote request form,
 * from what the owner said they need to know to quote a job, in the question
 * tray. One compact row each: the question, which wraps, its type, a Required switch and a remove
 * button that shows on hover or focus. The owner makes a question optional or
 * drops one, and confirms with "Use this form". Any other change is typed in
 * the composer, and the message they send is the answer to this card
 * (`changes`), not a new subject. Nothing is sent until they press or send.
 * Once answered it shows nothing: the owner's reply after it says what they
 * settled on.
 */

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
  // A choice's options, then any hint, on one muted line.
  const detail = [field.options?.join(", "), field.hint]
    .filter(Boolean)
    .join(" · ")
  return (
    <li className="group flex items-center gap-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="wrap-break-word font-medium text-sm">{name}</span>
        {detail ? (
          <span className="truncate text-muted-foreground text-xs">
            {detail}
          </span>
        ) : null}
      </div>
      <span className="shrink-0 text-muted-foreground text-xs">
        {QUOTE_TYPE_LABEL[field.type]}
      </span>
      {/* biome-ignore lint/a11y/noLabelWithoutControl: the switch is a span with a hidden input, which the rule cannot see */}
      <label className="flex shrink-0 cursor-pointer items-center gap-2 text-muted-foreground text-xs">
        <Switch
          aria-label={`${name}, required`}
          checked={field.required}
          onCheckedChange={(required) =>
            onChange(setRequired(draft, field.key, required))
          }
        />
        Required
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

  return (
    <Docked name="review-quote-form">
      <TrayFrame
        collapsed={collapsed}
        hint={view.input.note}
        onCollapsedChange={setCollapsed}
        question="Questions for your quote form"
        submit={{ label: "Use this form", onSubmit: confirm }}
      >
        <p className="px-1 text-muted-foreground text-xs">
          The form also asks for name, email and phone.
        </p>
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
