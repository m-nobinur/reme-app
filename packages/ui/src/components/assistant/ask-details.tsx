import type { ToolCallMessagePartComponent } from "@assistant-ui/react"
import {
  type AskDetailsInput,
  AVATARS,
  DETAILS_KEYS,
  type FactValue,
  NAME_IDEAS,
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
import { DoneIcon } from "@workspace/ui/components/status-line"
import { Hint } from "@workspace/ui/components/tooltip"
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
 * assistant's name page offers Pick for me while the name is empty, which
 * sends at once with the first name idea and the prefill for anything left
 * empty, and the owner's reply reads Pick for me. The business email starts
 * empty, with a chip on its label's row that fills in the sign-in email while
 * the field is empty.
 * Once answered or skipped it shows nothing: the owner's reply after it says
 * what they gave.
 */

type Answer = {
  answer: "stated"
  facts: FactValue[]
  skip_all?: boolean
  changed: string[]
}

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

/** A line under a field that says what happens to the answer. */
const HINT: Partial<Record<string, string>> = {
  "business.email":
    "Shown on your website. Use a business address if you have one.",
}

const CHIP =
  "h-7 max-w-full truncate rounded-full border border-border bg-card px-3 text-xs transition-colors hover:border-foreground/40 hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"

/** The names written for this business, or the house ones without them. */
const nameIdeas = (written: readonly string[] | undefined) =>
  written?.length ? written : NAME_IDEAS

/** Values a tap each puts in a field, under it. */
function FillChips({
  label,
  values,
  onPick,
}: {
  label: string
  values: readonly string[]
  onPick: (value: string) => void
}) {
  if (values.length === 0) return null
  return (
    <ul aria-label={label} className="flex flex-wrap gap-2 pt-1">
      {values.map((value) => (
        <li key={value}>
          <button className={CHIP} onClick={() => onPick(value)} type="button">
            {value}
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
                <DoneIcon className="ml-auto" />
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
              <DoneIcon className="absolute top-1 right-1 rounded-full bg-card" />
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
  const ideas = nameIdeas(input.ideas)
  // Watched so a chip never repeats the name typed, and Pick for me shows
  // only while the name is empty.
  const [assistantName, setName] = useState(() =>
    String(startOf("assistant.name", "name") ?? "")
  )
  // The sign-in email chip shows only while the email field is empty.
  const [email, setEmail] = useState(() =>
    String(startOf("business.email", fieldOf("business.email")) ?? "")
  )

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
  // A field whose page Next just hid was checked by Next, and `key` is the
  // new page's: checking it would flag the next field before it is typed in.
  const checkOnLeave = (event: FocusEvent<HTMLFormElement>) => {
    const field = event.target
    if (!(field instanceof HTMLInputElement) || isPick(key)) return
    if (!field.value.trim() || field.closest("[hidden]")) return
    const result = read(key, values())
    setProblem("error" in result ? result.error : null)
  }

  // An error shown stays only while the field is wrong: typing a valid value clears it.
  const clearWhenValid = (event: FormEvent<HTMLFormElement>) => {
    if (!problem || !(event.target instanceof HTMLInputElement)) return
    if (isPick(key) || event.target.closest("[hidden]")) return
    if (!("error" in read(key, values()))) setProblem(null)
  }

  /** The keys whose field in `set` holds something other than the card offered. */
  const changedIn = (set: Record<string, string>) =>
    keys.filter((each) => {
      const offered = prefilled(input, each)
      return isPick(each)
        ? (set[each] ?? "") !== "" && set[each] !== String(offered?.id ?? "")
        : FACT_INPUTS[each].fields.some(
            (field) =>
              (set[field.name] ?? "").trim() !== "" &&
              set[field.name] !== String(offered?.[field.name] ?? "")
          )
    })
  /** Every key's fact from `held`, else the page of the first one wrong. */
  const send = (held: Record<string, string>, picked = false) => {
    const facts: FactValue[] = []
    for (const [at, each] of keys.entries()) {
      const result = read(each, held)
      if ("error" in result) return show(at, result.error)
      facts.push(result.fact)
    }
    // The draft stays: a refused answer reopens the card with it.
    onAnswer({
      answer: "stated",
      facts,
      changed: changedIn(picked ? values() : held),
      ...(picked && { skip_all: true }),
    })
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (last) send(values())
    else forward()
  }
  /** Puts a value in a key's first field, as if typed. */
  const fill = (each: DetailsKey, value: string) => {
    const field = formRef.current?.querySelector<HTMLInputElement>(
      `[name="${fieldOf(each)}"]`
    )
    if (!field) return
    field.value = value
    if (each === "assistant.name") setName(value)
    if (each === "business.email") setEmail(value)
    setProblem(null)
    save({ page, values: values() })
    field.focus()
  }
  // What the owner set, the prefill for any field left empty, and the first
  // name idea for an empty name.
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
                  String(
                    value?.[field.name] ??
                      (each === "assistant.name" ? ideas[0] : "")
                  ),
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
      page={{ index: page, total: keys.length }}
      pick={
        key === "assistant.name" && !assistantName.trim()
          ? { onPick: pickForMe }
          : undefined
      }
      question={askOf(key)}
      submit={{ form: `${id}-form` }}
    >
      <form
        id={`${id}-form`}
        noValidate
        onBlur={checkOnLeave}
        onInput={clearWhenValid}
        onChange={(event) => {
          // Stored only, not state: the fields already hold what is typed.
          save({ page, values: values() })
          const field = event.target
          if (!(field instanceof HTMLInputElement)) return
          if (field.name === "assistant.pronouns") {
            setPronouns(field.value as PronounId)
          } else if (field.name === fieldOf("assistant.name")) {
            setName(field.value)
          } else if (field.name === fieldOf("business.email")) {
            setEmail(field.value)
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
                  <div className="relative">
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
                    {each === "business.email" &&
                    input.sign_in_email &&
                    !email.trim() ? (
                      <Hint label={input.sign_in_email} side="top">
                        <button
                          className={cn(
                            CHIP,
                            "absolute -top-1 right-0 h-6 max-w-[60%]"
                          )}
                          data-slot="sign-in-email"
                          onClick={() =>
                            fill(each, input.sign_in_email as string)
                          }
                          type="button"
                        >
                          Use {input.sign_in_email}
                        </button>
                      </Hint>
                    ) : null}
                  </div>
                  {each === "assistant.name" ? (
                    <FillChips
                      label="Name ideas"
                      onPick={(value) => fill(each, value)}
                      values={ideas.filter(
                        (idea) => idea !== assistantName.trim()
                      )}
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
  if (view.state !== "pending")
    return <TrayNote name="ask-details" view={view} />
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
