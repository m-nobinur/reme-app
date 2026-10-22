import type { ToolCallMessagePartComponent } from "@assistant-ui/react"
import { CheckCircleIcon } from "@phosphor-icons/react"
import {
  type AskDetailsInput,
  DETAILS_KEYS,
  type FactValue,
  PRONOUNS,
  TONES,
} from "@workspace/contracts"
import {
  Docked,
  TrayFrame,
  TrayNote,
  useTabDraft,
} from "@workspace/ui/components/assistant/question-tray"
import { AnswerInputs } from "@workspace/ui/components/live-panel"
import { answerValue, FACT_INPUTS } from "@workspace/ui/lib/answer"
import {
  FIELD_ERROR,
  OPTION,
  OPTION_PILL,
  OPTION_TILE,
} from "@workspace/ui/lib/card"
import { factLabel } from "@workspace/ui/lib/facts"
import { askDetailsView } from "@workspace/ui/lib/tool-state"
import { cn } from "@workspace/ui/lib/utils"
import { type FocusEvent, type FormEvent, useId, useRef, useState } from "react"

/**
 * A few related facts onboarding asks for in the question tray, one field
 * per page: the phone and then the email, or the assistant's name, pronouns
 * and tone. The inputs are the web's, by key, the same ones `ask_fact` uses,
 * so a phone is typed the way the owner writes it and sent as E.164. Every
 * field is needed and checked as the owner leaves its page; nothing is sent
 * until the last one reads. Every page stays in the form, hidden, so going
 * back finds what was typed, and a reload resumes on the page reached. Once
 * answered or skipped it shows nothing: the owner's reply after it says what
 * they gave.
 */

type Answer = { answer: "stated"; facts: FactValue[] } | { answer: "skipped" }

const PICKS = {
  "assistant.pronouns": {
    legend: "Pronouns",
    ask: "Which pronouns should your assistant use?",
    options: PRONOUNS,
  },
  "assistant.tone": {
    legend: "Tone",
    ask: "How should your assistant sound?",
    options: TONES,
  },
} as const

type PickKey = keyof typeof PICKS

/** A key a details tray asks for. */
type DetailsKey = (typeof DETAILS_KEYS)[keyof typeof DETAILS_KEYS][number]

const isPick = (key: string): key is PickKey => key in PICKS

/**
 * A line under a field that says where the answer ends up. The sign-in email
 * is prefilled here, so the owner needs to know it is public.
 */
const HINT: Partial<Record<string, string>> = {
  "business.email":
    "Shown on your website. Use a business address if you have one.",
}

/** The page's question: the web's copy for the key. */
const askOf = (key: DetailsKey) =>
  isPick(key) ? PICKS[key].ask : FACT_INPUTS[key].ask

/** The value `prefill` gives a key, if any, by field name. */
const prefilled = (input: AskDetailsInput, key: DetailsKey) =>
  (input.prefill.find((fact) => fact.key === key)?.value ?? null) as Record<
    string,
    unknown
  > | null

/** The input a key's page focuses: its first field. */
const fieldOf = (key: DetailsKey) =>
  isPick(key) ? key : (FACT_INPUTS[key].fields[0]?.name ?? "")

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
      <legend className="sr-only">{legend}</legend>
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

type Draft = { page: number; values: Record<string, string> }

/** The tray's pages, one key each. `onAnswer` gets the answer `AskDetailsOutput` takes. */
function DetailsTray({
  input,
  draftId,
  onAnswer,
}: {
  input: AskDetailsInput
  /** Where the answers so far are kept for this tab: the call's id. */
  draftId: string
  onAnswer: (answer: Answer) => void
}) {
  const id = useId()
  const keys: readonly DetailsKey[] = DETAILS_KEYS[input.step]
  const { draft, keep, clear } = useTabDraft<Draft>(draftId, {
    page: 0,
    values: {},
  })
  const [page, setPage] = useState(Math.min(draft.page, keys.length - 1))
  const [collapsed, setCollapsed] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const key = keys[page] ?? keys[0]
  const last = page === keys.length - 1
  const several = keys.length > 1

  /** What every field holds now, by name. */
  const values = () =>
    Object.fromEntries(
      [...new FormData(formRef.current ?? undefined)].map(([name, value]) => [
        name,
        String(value),
      ])
    )
  /** A key's fact, or what is wrong with it. */
  const read = (
    each: DetailsKey,
    held: Record<string, string>
  ): { fact: FactValue } | { error: string } => {
    if (isPick(each)) {
      const picked = held[each]
      return picked
        ? { fact: { key: each, value: { id: picked } } as FactValue }
        : { error: `Pick the ${PICKS[each].legend.toLowerCase()}.` }
    }
    const parsed = answerValue(
      { kind: "fact", key: each },
      (name) => held[name] ?? ""
    )
    return "error" in parsed
      ? parsed
      : { fact: { key: each, value: parsed.value } as FactValue }
  }
  const show = (to: number, why: string | null) => {
    setProblem(why)
    if (to !== page) setPage(to)
    if (why) {
      formRef.current
        ?.querySelector<HTMLInputElement>(
          `[name="${fieldOf(keys[to] ?? key)}"]`
        )
        ?.focus()
    }
  }
  const forward = () => {
    const held = values()
    const result = read(key, held)
    if ("error" in result) return show(page, result.error)
    keep({ page: page + 1, values: held })
    show(page + 1, null)
  }
  const back = () => {
    keep({ page: page - 1, values: values() })
    show(page - 1, null)
  }

  // Leaving a filled field checks it, so a wrong number shows before Next;
  // an empty one waits for Next or Submit, and focus stays where it went.
  const checkOnLeave = (event: FocusEvent<HTMLFormElement>) => {
    const field = event.target
    if (!(field instanceof HTMLInputElement) || isPick(key)) return
    if (!field.value.trim()) return
    const result = read(key, values())
    setProblem("error" in result ? result.error : null)
  }

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!last) return forward()
    const held = values()
    const facts: FactValue[] = []
    for (const [at, each] of keys.entries()) {
      const result = read(each, held)
      if ("error" in result) return show(at, result.error)
      facts.push(result.fact)
    }
    clear()
    onAnswer({ answer: "stated", facts })
  }

  // A value typed on an earlier visit, else the call's own prefill.
  const startOf = (each: DetailsKey, name: string) =>
    draft.values[name] ?? prefilled(input, each)?.[name]

  return (
    <TrayFrame
      collapsed={collapsed}
      onBack={page > 0 ? back : undefined}
      onCollapsedChange={setCollapsed}
      onForward={last ? undefined : forward}
      page={{ index: page, total: keys.length }}
      question={askOf(key)}
      skip={
        input.skippable
          ? {
              label: several ? "Skip all" : "Skip",
              onSkip: () => {
                clear()
                onAnswer({ answer: "skipped" })
              },
            }
          : undefined
      }
      submit={{ label: last ? "Submit" : "Next", form: `${id}-form` }}
    >
      <form
        id={`${id}-form`}
        noValidate
        onBlur={checkOnLeave}
        onSubmit={submit}
        ref={formRef}
      >
        {keys.map((each, at) => {
          const invalid = at === page ? (problem ?? undefined) : undefined
          return (
            <div
              className="flex flex-col gap-1.5"
              hidden={at !== page}
              key={each}
            >
              {isPick(each) ? (
                <Picks
                  invalid={invalid}
                  name={each}
                  // A pick's value is its id, kept under the key's own name.
                  start={
                    draft.values[each] ??
                    (String(prefilled(input, each)?.id ?? "") || null)
                  }
                />
              ) : (
                <>
                  <AnswerInputs
                    id={`${id}-${each}`}
                    invalid={invalid !== undefined}
                    prefill={Object.fromEntries(
                      FACT_INPUTS[each].fields.map((field) => [
                        field.name,
                        startOf(each, field.name),
                      ])
                    )}
                    spec={{ kind: "fact", key: each }}
                    title={factLabel(each)}
                  />
                  {HINT[each] ? (
                    <p className="text-muted-foreground text-xs">
                      {HINT[each]}
                    </p>
                  ) : null}
                  {invalid ? (
                    <p className={FIELD_ERROR} role="alert">
                      {invalid}
                    </p>
                  ) : null}
                </>
              )}
            </div>
          )
        })}
      </form>
    </TrayFrame>
  )
}

const AskDetails: ToolCallMessagePartComponent = (props) => {
  const view = askDetailsView(props)
  if (view.state === "answered" || view.state === "skipped") return null
  if (view.state !== "pending") {
    return (
      <TrayNote
        error={view.state === "error" ? view.message : null}
        name="ask-details"
      />
    )
  }
  return (
    <Docked name="ask-details">
      <DetailsTray
        draftId={props.toolCallId}
        input={view.input}
        onAnswer={props.addResult}
      />
    </Docked>
  )
}
AskDetails.displayName = "AskDetails"

export { AskDetails }
