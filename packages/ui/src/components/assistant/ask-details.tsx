import type { ToolCallMessagePartComponent } from "@assistant-ui/react"
import { CheckCircleIcon } from "@phosphor-icons/react"
import {
  type AskDetailsInput,
  AVATARS,
  DETAILS_KEYS,
  type FactValue,
  PRONOUNS,
  type PronounId,
  TONES,
} from "@workspace/contracts"
import {
  Docked,
  TrayFrame,
  TrayNote,
  useTabDraft,
} from "@workspace/ui/components/assistant/question-tray"
import { AssistantAvatar } from "@workspace/ui/components/assistant-avatar"
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
 * per page: the phone and then the email, or the assistant's name, pronouns,
 * face and tone. The inputs are the web's, by key, the same ones `ask_fact` uses,
 * so a phone is typed the way the owner writes it and sent as E.164. Every
 * field is needed and checked as the owner leaves its page; nothing is sent
 * until the last one reads. Every page stays in the form, hidden, so going
 * back finds what was typed, and a reload resumes on the page reached. The
 * assistant's pages also offer Pick for me, which sends at once with the
 * prefill for anything left empty, and the owner's reply reads Pick for me.
 * Once answered or skipped it shows nothing: the owner's reply after it says
 * what they gave.
 */

type Answer = { answer: "stated"; facts: FactValue[]; skip_all?: boolean }

const PICKS = {
  "assistant.pronouns": {
    legend: "Pronouns",
    ask: "Which pronouns should your assistant use?",
    options: PRONOUNS,
  },
  "assistant.avatar": {
    legend: "Look",
    ask: "How should your assistant look?",
    options: AVATARS,
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

/**
 * Reme first, so an owner can take the product's own name in one tap, then
 * the names written for this business, or a few plain ones without them.
 */
const nameIdeas = (written: readonly string[] | undefined) => [
  "Reme",
  ...(written?.length ? written : ["Ava", "Ellie", "Marcus"]),
]

/** Name ideas, a tap each to fill the name field. */
function NameIdeas({
  ideas,
  onPick,
}: {
  ideas: readonly string[]
  onPick: (name: string) => void
}) {
  return (
    <ul aria-label="Name ideas" className="flex flex-wrap gap-2 pt-1">
      {ideas.map((name) => (
        <li key={name}>
          <button
            className="h-7 rounded-full border border-border bg-card px-3 text-xs transition-colors hover:border-foreground/40 hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            onClick={() => onPick(name)}
            type="button"
          >
            {name}
          </button>
        </li>
      ))}
    </ul>
  )
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

/**
 * The faces for the pronouns picked a page before: Reme's own first and
 * ticked until the owner picks another. A face the new pronouns leave out
 * falls back to Reme's.
 */
function AvatarPicks({
  pronouns,
  start,
}: {
  pronouns: PronounId | null
  start: string | null
}) {
  const [picked, setPicked] = useState(start ?? "reme")
  const options = AVATARS.filter(
    (avatar) =>
      avatar.pronouns === null || !pronouns || avatar.pronouns === pronouns
  )
  const shown = options.some((avatar) => avatar.id === picked) ? picked : "reme"
  return (
    <fieldset>
      <legend className="sr-only">{PICKS["assistant.avatar"].legend}</legend>
      {/* Spread across the card in equal columns, five when every face shows. */}
      <div
        className={cn(
          "grid gap-3",
          options.length > 4 ? "grid-cols-5" : "grid-cols-4"
        )}
      >
        {options.map((avatar, at) => (
          <label
            className={cn(
              OPTION,
              "items-center justify-center rounded-2xl p-3"
            )}
            key={avatar.id}
            title={avatar.label}
          >
            <input
              checked={shown === avatar.id}
              className="sr-only"
              name="assistant.avatar"
              onChange={() => setPicked(avatar.id)}
              type="radio"
              value={avatar.id}
            />
            <span className="sr-only">{avatar.label}</span>
            <AssistantAvatar
              className="size-14 sm:size-18"
              delay={at * 1.3}
              id={avatar.id}
            />
            {shown === avatar.id ? (
              <CheckCircleIcon
                aria-hidden
                className="absolute top-1 right-1 size-4 rounded-full bg-card text-primary"
                weight="fill"
              />
            ) : null}
          </label>
        ))}
      </div>
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
  const { draft, keep, save } = useTabDraft<Draft>(draftId, {
    page: 0,
    values: {},
  })
  // Where this tab left off, else the first page without an answer: a name
  // the owner typed in the chat comes back filled, so the card opens past it.
  // With every page filled it opens on the first.
  const firstOpen = keys.findIndex((each) => prefilled(input, each) === null)
  const [page, setPage] = useState(
    Object.keys(draft.values).length > 0
      ? Math.min(draft.page, keys.length - 1)
      : Math.max(firstOpen, 0)
  )
  const [collapsed, setCollapsed] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // A value typed on an earlier visit, else the call's own prefill.
  const startOf = (each: DetailsKey, name: string) =>
    draft.values[name] ?? prefilled(input, each)?.[name]

  // The faces on offer follow the pronouns picked a page before.
  const [pronouns, setPronouns] = useState(
    () =>
      (draft.values["assistant.pronouns"] ||
        String(prefilled(input, "assistant.pronouns")?.id ?? "") ||
        null) as PronounId | null
  )
  const formRef = useRef<HTMLFormElement>(null)
  const key = keys[page] ?? keys[0]
  const last = page === keys.length - 1

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

  /** Every key's fact from `held`, else the page of the first one wrong. */
  const send = (held: Record<string, string>, picked = false) => {
    const facts: FactValue[] = []
    for (const [at, each] of keys.entries()) {
      const result = read(each, held)
      if ("error" in result) return show(at, result.error)
      facts.push(result.fact)
    }
    // The draft stays: a refused answer reopens the card with it.
    onAnswer({ answer: "stated", facts, ...(picked && { skip_all: true }) })
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (last) send(values())
    else forward()
  }
  // What the owner set, and the prefill for any field left empty.
  const pickForMe = () =>
    send(
      {
        ...Object.fromEntries(
          keys.flatMap((each) => {
            const value = prefilled(input, each)
            return isPick(each)
              ? [[each, String(value?.id ?? "")]]
              : FACT_INPUTS[each].fields.map((field) => [
                  field.name,
                  String(value?.[field.name] ?? ""),
                ])
          })
        ),
        ...Object.fromEntries(
          Object.entries(values()).filter(([, value]) => value.trim())
        ),
      },
      true
    )

  return (
    <TrayFrame
      collapsed={collapsed}
      onBack={page > 0 ? back : undefined}
      onCollapsedChange={setCollapsed}
      onForward={last ? undefined : forward}
      page={{ index: page, total: keys.length }}
      pick={input.step === "assistant" ? { onPick: pickForMe } : undefined}
      question={askOf(key)}
      submit={{
        label: last ? "Looks good" : "Next",
        form: `${id}-form`,
      }}
    >
      <form
        id={`${id}-form`}
        noValidate
        onBlur={checkOnLeave}
        onChange={(event) => {
          // Stored only, not state: the fields already hold what is typed.
          save({ page, values: values() })
          const field = event.target
          if (
            field instanceof HTMLInputElement &&
            field.name === "assistant.pronouns"
          ) {
            setPronouns(field.value as PronounId)
          }
        }}
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
              {each === "assistant.avatar" ? (
                <AvatarPicks
                  pronouns={pronouns}
                  start={
                    draft.values[each] ??
                    (String(prefilled(input, each)?.id ?? "") || null)
                  }
                />
              ) : isPick(each) ? (
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
                  {each === "assistant.name" ? (
                    <NameIdeas
                      ideas={nameIdeas(input.ideas)}
                      onPick={(name) => {
                        const field =
                          formRef.current?.querySelector<HTMLInputElement>(
                            `[name="${fieldOf(each)}"]`
                          )
                        if (!field) return
                        field.value = name
                        setProblem(null)
                        field.focus()
                      }}
                    />
                  ) : null}
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
  if (view.state === "answered" || view.state === "skipped") {
    return null
  }
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
