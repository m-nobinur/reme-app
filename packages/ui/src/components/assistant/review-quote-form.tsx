import type { ToolCallMessagePartComponent } from "@assistant-ui/react"
import {
  ArrowCounterClockwiseIcon,
  CalendarBlankIcon,
  CaretDownIcon,
  CheckCircleIcon,
  TrashIcon,
} from "@phosphor-icons/react"
import type { QuoteField } from "@workspace/contracts"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { useFocusComposer } from "@workspace/ui/hooks/use-composer-input"
import { useRevealWaiting } from "@workspace/ui/hooks/use-reveal-waiting"
import {
  canDrop,
  confirmedFields,
  DROP_LIMIT,
  draftOf,
  dropField,
  keptFields,
  labelProblem,
  QUOTE_LABEL_MAX,
  QUOTE_TYPE_LABEL,
  type QuoteDraft,
  renameField,
  restoreField,
  setRequired,
} from "@workspace/ui/lib/quote-form"
import { reviewQuoteFormView } from "@workspace/ui/lib/tool-state"
import { cn } from "@workspace/ui/lib/utils"
import { useId, useState } from "react"

/**
 * The questions the assistant proposes for the site's quote request form,
 * from what the owner said they need to know to quote a job. The owner
 * renames, drops, restores or makes optional each one, watches the form
 * change beside the list, and confirms with "Looks good". Anything else is
 * said in their own words: "I'd change something" puts them in the composer,
 * and the message they send is the answer to this card (`changes`), not a
 * new subject. Nothing is sent until they press or send. Once answered it
 * shows nothing: the owner's reply after it says what they settled on.
 */

/** How the form reads on the site, drawn from the list as it stands. */
function Preview({ fields }: { fields: QuoteField[] }) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl bg-muted/50 p-3">
      <p className="font-medium text-muted-foreground text-xs">
        How visitors see it
      </p>
      {/* A drawing of the list the owner is editing, which the list itself
          already gives a screen reader. */}
      <div aria-hidden className="flex flex-col gap-2 text-xs">
        <p className="text-muted-foreground">Name, email and phone, then:</p>
        {fields.map((field) => (
          <div className="flex flex-col gap-1" key={field.key}>
            <span className="truncate font-medium">
              {field.label || " "}
              {field.required ? null : (
                <span className="font-normal text-muted-foreground">
                  {" "}
                  optional
                </span>
              )}
            </span>
            <span
              className={cn(
                "flex items-center justify-end rounded-md border border-border bg-card px-1.5 text-muted-foreground",
                field.type === "textarea" ? "h-10 items-start pt-1" : "h-6"
              )}
            >
              {field.type === "select" ? (
                <>
                  <span className="mr-auto truncate">{field.options?.[0]}</span>
                  <CaretDownIcon className="size-3 shrink-0" />
                </>
              ) : field.type === "date" ? (
                <CalendarBlankIcon className="size-3 shrink-0" />
              ) : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

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
  const id = useId()
  const { field } = row
  const name = field.label.trim() || `question ${index + 1}`
  if (row.dropped) {
    return (
      <li className="flex min-h-11 items-center gap-2 py-2">
        <span className="min-w-0 flex-1 truncate text-muted-foreground text-sm line-through">
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
  const problem = labelProblem(draft, field.key)
  const locked = !canDrop(draft)
  const described =
    [field.hint ? `${id}-hint` : "", problem ? `${id}-problem` : ""]
      .filter(Boolean)
      .join(" ") || undefined
  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex items-center gap-2">
        <Input
          aria-describedby={described}
          aria-invalid={problem !== null || undefined}
          aria-label={`Question ${index + 1}`}
          className="-ml-2 h-9 flex-1 rounded-xl border-transparent bg-transparent px-2 font-medium hover:border-border"
          maxLength={QUOTE_LABEL_MAX}
          onChange={(event) =>
            onChange(renameField(draft, field.key, event.currentTarget.value))
          }
          value={field.label}
        />
        <Badge className="shrink-0" variant="outline">
          {QUOTE_TYPE_LABEL[field.type]}
        </Badge>
        <Button
          aria-describedby={locked ? limitId : undefined}
          aria-disabled={locked || undefined}
          aria-label={`Remove ${name}`}
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          onClick={() => {
            if (!locked) onChange(dropField(draft, field.key))
          }}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <TrashIcon aria-hidden />
        </Button>
      </div>
      {field.options ? (
        <p className="text-muted-foreground text-xs">
          Choices: {field.options.join(", ")}
        </p>
      ) : null}
      {field.hint ? (
        <p className="text-muted-foreground text-xs" id={`${id}-hint`}>
          {field.hint}
        </p>
      ) : null}
      {problem ? (
        <p className="text-destructive text-xs" id={`${id}-problem`}>
          {problem}
        </p>
      ) : null}
      <label className="inline-flex min-h-8 w-fit cursor-pointer items-center gap-2 text-sm">
        <input
          checked={field.required}
          className="size-4 accent-primary"
          onChange={(event) =>
            onChange(setRequired(draft, field.key, event.currentTarget.checked))
          }
          type="checkbox"
        />
        Required
      </label>
    </li>
  )
}

const ReviewQuoteForm: ToolCallMessagePartComponent = (props) => {
  const view = reviewQuoteFormView(props)
  useRevealWaiting(view.state === "pending")
  const focusComposer = useFocusComposer()
  const [draft, setDraft] = useState<QuoteDraft>(() =>
    view.state === "pending" ? draftOf(view.input.fields) : []
  )
  const [invalid, setInvalid] = useState<string | null>(null)
  const [writing, setWriting] = useState(false)
  const id = useId()

  if (view.state === "answered") return null
  if (view.state !== "pending") {
    return (
      <div className="my-3 max-w-2xl" data-slot="review-quote-form">
        <p
          className={cn(
            "text-sm",
            view.state === "error"
              ? "text-destructive"
              : "text-muted-foreground"
          )}
        >
          {view.state === "error"
            ? view.message
            : "You replied in the chat instead."}
        </p>
      </div>
    )
  }

  const kept = keptFields(draft)
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
    <section
      aria-labelledby={`${id}-title`}
      className="@container my-3 flex max-w-2xl flex-col gap-4 rounded-3xl border border-border bg-card p-4 text-card-foreground"
      data-slot="review-quote-form"
    >
      <div className="flex flex-col gap-1">
        <h3 className="font-medium text-sm" id={`${id}-title`}>
          Questions for your quote form
        </h3>
        {view.input.note ? (
          <p className="max-w-prose text-muted-foreground text-sm">
            {view.input.note}
          </p>
        ) : null}
      </div>
      <div className="grid @xl:grid-cols-[minmax(0,1fr)_14rem] gap-4">
        <div className="flex min-w-0 flex-col">
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
          {canDrop(draft) ? null : (
            <p className="text-muted-foreground text-xs" id={`${id}-limit`}>
              {DROP_LIMIT}
            </p>
          )}
        </div>
        <Preview fields={kept} />
      </div>
      {invalid ? (
        <p className="text-[0.8125rem] text-destructive" role="alert">
          {invalid}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={confirm} size="sm" type="button">
          <CheckCircleIcon aria-hidden />
          Looks good
        </Button>
        <Button
          onClick={() => {
            setWriting(true)
            focusComposer()
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          I'd change something
        </Button>
      </div>
      <p
        className={cn(
          "text-muted-foreground text-xs",
          writing ? null : "sr-only"
        )}
        role="status"
      >
        {writing
          ? "Write what to change in the message box below and send it. Your message answers this card."
          : ""}
      </p>
    </section>
  )
}
ReviewQuoteForm.displayName = "ReviewQuoteForm"

export { ReviewQuoteForm }
