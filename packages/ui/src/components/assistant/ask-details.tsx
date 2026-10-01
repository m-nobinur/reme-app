import type { ToolCallMessagePartComponent } from "@assistant-ui/react"
import { CheckCircleIcon } from "@phosphor-icons/react"
import {
  type AskDetailsInput,
  DETAILS_KEYS,
  type FactValue,
  PRONOUNS,
  TONES,
} from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import { AnswerInputs } from "@workspace/ui/components/live-panel"
import {
  useFocusWhenIdle,
  useRevealWaiting,
} from "@workspace/ui/hooks/use-reveal-waiting"
import { answerValue, askable, FACT_INPUTS } from "@workspace/ui/lib/answer"
import {
  CARD_SURFACE,
  FIELD_ERROR,
  OPTION,
  OPTION_PILL,
  OPTION_TILE,
} from "@workspace/ui/lib/card"
import { factLabel } from "@workspace/ui/lib/facts"
import { askDetailsView } from "@workspace/ui/lib/tool-state"
import { cn } from "@workspace/ui/lib/utils"
import { type FormEvent, useId, useRef, useState } from "react"

/**
 * A few related facts onboarding asks for on one card: the phone and email
 * together, or the assistant's name, pronouns and tone. The question is the
 * text part above; the inputs are the web's, by key, the same ones
 * `ask_fact` uses, so a phone is typed the way the owner writes it and sent
 * as E.164. Every field is needed, checked in place when the owner presses
 * Continue, and nothing is sent until each one reads. Once answered or
 * skipped it shows nothing: the owner's reply after it says what they gave.
 */

type Answer = { answer: "stated"; facts: FactValue[] } | { answer: "skipped" }

const PICKS = {
  "assistant.pronouns": { legend: "Pronouns", options: PRONOUNS },
  "assistant.tone": { legend: "Tone", options: TONES },
} as const

type PickKey = keyof typeof PICKS

const isPick = (key: string): key is PickKey => key in PICKS

/** The value `prefill` gives a key, if any. */
const prefilled = (input: AskDetailsInput, key: string) =>
  input.prefill.find((fact) => fact.key === key)?.value ?? null

/** Pills, or tiles when the options carry a hint, as one native radio group. */
function Picks({
  name,
  start,
  invalid,
}: {
  name: PickKey
  start: string | null
  invalid: string | undefined
}) {
  const id = useId()
  const { legend, options } = PICKS[name]
  const tiles = options.some((option) => "hint" in option)
  const [picked, setPicked] = useState(start)
  return (
    <fieldset
      aria-describedby={invalid ? `${id}-error` : undefined}
      className="flex flex-col gap-2"
    >
      <legend className="mb-2 font-medium text-sm">{legend}</legend>
      <div
        className={cn(
          tiles
            ? "grid grid-cols-1 gap-2 sm:grid-cols-3"
            : "flex flex-wrap gap-2"
        )}
      >
        {options.map((option) => (
          <label
            className={cn(OPTION, tiles ? OPTION_TILE : OPTION_PILL)}
            key={option.id}
          >
            <input
              checked={picked === option.id}
              className="sr-only"
              name={name}
              onChange={() => setPicked(option.id)}
              type="radio"
              value={option.id}
            />
            <span
              className={cn(
                "flex items-center gap-1.5",
                tiles && "font-medium text-sm"
              )}
            >
              {option.label}
              {tiles && picked === option.id ? (
                <CheckCircleIcon
                  aria-hidden
                  className="ml-auto size-4 shrink-0 text-primary"
                  weight="fill"
                />
              ) : null}
            </span>
            {"hint" in option ? (
              <span className="text-muted-foreground text-xs">
                {option.hint}
              </span>
            ) : null}
          </label>
        ))}
      </div>
      {invalid ? (
        <p className={FIELD_ERROR} id={`${id}-error`} role="alert">
          {invalid}
        </p>
      ) : null}
    </fieldset>
  )
}

/** The open card. `onAnswer` gets the answer `AskDetailsOutput` takes. */
function DetailsForm({
  input,
  onAnswer,
}: {
  input: AskDetailsInput
  onAnswer: (answer: Answer) => void
}) {
  const id = useId()
  const [problems, setProblems] = useState<Record<string, string>>({})
  const keys = DETAILS_KEYS[input.step]

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const read = (name: string) => String(form.get(name) ?? "")
    const facts: FactValue[] = []
    const found: Record<string, string> = {}
    for (const key of keys) {
      if (isPick(key)) {
        const picked = read(key)
        if (picked) facts.push({ key, value: { id: picked } } as FactValue)
        else found[key] = `Pick the ${PICKS[key].legend.toLowerCase()}.`
      } else if (askable(key)) {
        const parsed = answerValue({ kind: "fact", key }, read)
        if ("error" in parsed) found[key] = parsed.error
        else facts.push({ key, value: parsed.value } as FactValue)
      }
    }
    setProblems(found)
    const first = keys.find((key) => found[key])
    if (first) {
      // The first field to fix takes the focus, so a keyboard lands on it.
      const name = isPick(first)
        ? first
        : (FACT_INPUTS[first as keyof typeof FACT_INPUTS].fields[0]?.name ?? "")
      event.currentTarget
        .querySelector<HTMLInputElement>(`[name="${name}"]`)
        ?.focus()
      return
    }
    onAnswer({ answer: "stated", facts })
  }

  // Text fields side by side from the small breakpoint, the picks under them.
  const typed = keys.filter((key) => !isPick(key) && askable(key))
  return (
    <form
      aria-label={`Your ${input.step === "contact" ? "contact details" : "assistant"}`}
      className={cn(CARD_SURFACE, "flex flex-col gap-4")}
      noValidate
      onSubmit={submit}
    >
      <div
        className={cn(
          "grid gap-4",
          typed.length > 1 ? "sm:grid-cols-2" : "max-w-sm"
        )}
      >
        {typed.map((key) =>
          askable(key) ? (
            <div className="flex min-w-0 flex-col gap-1.5" key={key}>
              <AnswerInputs
                id={`${id}-${key}`}
                invalid={key in problems}
                prefill={prefilled(input, key)}
                spec={{ kind: "fact", key }}
                title={factLabel(key)}
              />
              {problems[key] ? (
                <p className={FIELD_ERROR} role="alert">
                  {problems[key]}
                </p>
              ) : null}
            </div>
          ) : null
        )}
      </div>
      {keys.filter(isPick).map((key) => {
        const start = prefilled(input, key)
        return (
          <Picks
            invalid={problems[key]}
            key={key}
            name={key}
            start={start && "id" in start ? String(start.id) : null}
          />
        )
      })}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="submit">
          Continue
        </Button>
        {input.skippable ? (
          <Button
            onClick={() => onAnswer({ answer: "skipped" })}
            size="sm"
            type="button"
            variant="outline"
          >
            Skip for now
          </Button>
        ) : null}
      </div>
    </form>
  )
}

const AskDetails: ToolCallMessagePartComponent = (props) => {
  const view = askDetailsView(props)
  const waiting = view.state === "pending"
  const running = useRevealWaiting(waiting)
  const cardRef = useRef<HTMLDivElement>(null)
  useFocusWhenIdle(waiting, running, cardRef)

  if (view.state === "answered" || view.state === "skipped") return null
  if (view.state !== "pending") {
    return (
      <div className="my-3 max-w-md" data-slot="ask-details">
        <p
          className={cn(
            "text-sm",
            view.state === "error"
              ? "text-destructive"
              : "text-muted-foreground"
          )}
        >
          {view.state === "cancelled"
            ? "You replied in the chat instead."
            : view.message}
        </p>
      </div>
    )
  }

  return (
    <div className="my-3 max-w-2xl" data-slot="ask-details" ref={cardRef}>
      <DetailsForm input={view.input} onAnswer={props.addResult} />
    </div>
  )
}
AskDetails.displayName = "AskDetails"

export { AskDetails }
