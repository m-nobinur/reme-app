import { makeAssistantDataUI, useAui, useAuiState } from "@assistant-ui/react"
import {
  addressReply,
  type BuildQuestion,
  type BuildQuestions,
  type QuestionAnswer,
  type QuestionReply,
} from "@workspace/contracts"
import { Done } from "@workspace/ui/components/assistant/decision"
import {
  Docked,
  TrayFrame,
} from "@workspace/ui/components/assistant/question-tray"
import { AnswerInputs } from "@workspace/ui/components/live-panel"
import { useFocusComposer } from "@workspace/ui/hooks/use-composer-input"
import { answerValue } from "@workspace/ui/lib/answer"
import { FIELD_ERROR } from "@workspace/ui/lib/card"
import { factText } from "@workspace/ui/lib/facts"
import {
  createContext,
  type FormEvent,
  useContext,
  useId,
  useState,
} from "react"

/**
 * What the assistant asks the owner for their website
 * (`data-build_questions`), in the question tray: one page a question, the
 * question in the assistant's words, its inputs, Skip where it may be
 * skipped. Send sends every answered page at once; a page that cannot go
 * yet is shown with why. Once every one is settled it folds to
 * one row and goes. Typing in the composer is an ordinary turn. The
 * address question is no build's, so once settled the owner's answer goes
 * on as their next message, for the assistant to act on.
 */

/**
 * Sends one answer: the stack as now stored, or null when stored without
 * one, else the words to show.
 */
export type AnswerBuildQuestion = (answer: {
  conversationId: string
  reply: QuestionReply
}) => Promise<BuildQuestions | string | null>

/** What the owner said to the address question, as their message; null when there is nothing to say. */
export function addressSaid(
  questions: readonly BuildQuestion[],
  answerOf: (question: BuildQuestion) => QuestionAnswer | undefined
) {
  const given = (kind: BuildQuestion["input"]["kind"]) => {
    const asked = questions.find((each) => each.input.kind === kind)
    const answer = asked && answerOf(asked)
    return answer?.kind === "value" && typeof answer.value === "string"
      ? answer.value
      : undefined
  }
  const choice = given("choice")
  return choice === undefined ? null : addressReply(choice, given("text"))
}

const AnswerContext = createContext<AnswerBuildQuestion | null>(null)

/** Gives the card the app's way to send an answer. */
export const AnswerBuildQuestionProvider = AnswerContext.Provider

/** The pause after an answer's tick before the next question, or the fold. */
export const ONWARD_MS = 600
/** How long the folded row stays before it goes. */
const FOLDED_MS = 1500

const FAILED = "That didn't go through. Try again."

type Phase = "asking" | "closing" | "folded" | "gone"

type Given = QuestionReply["answer"]
/** Answers by question id. */
type Answers = Record<string, QuestionAnswer>

/** A settled question as the owner reads it. */
function settledLine(question: BuildQuestion, answer: QuestionAnswer) {
  if (answer.kind === "skipped") return "Skipped"
  if (answer.kind === "closed") return "I don't need this one any more"
  return question.input.kind === "fact"
    ? factText(question.input.key, answer.value)
    : String(answer.value)
}

/**
 * The question to show after `from` is settled: the next open one after
 * it, else the first open one before it, else none.
 */
export function nextOpen(
  questions: readonly BuildQuestion[],
  settled: (question: BuildQuestion) => boolean,
  from: number
): number | undefined {
  const open = questions.flatMap((each, at) =>
    at !== from && !settled(each) ? [at] : []
  )
  return open.find((at) => at > from) ?? open[0]
}

function BuildQuestionsPart({ data }: { data: BuildQuestions }) {
  const send = useContext(AnswerContext)
  const aui = useAui()
  const messageId = useAuiState((s) => s.message.id)
  const conversationId = useAuiState((s) => s.threadListItem.remoteId)
  const id = useId()
  const { questions } = data
  // Answers stored from this tab, until the message is read again with them.
  const [given, setGiven] = useState<Answers>({})
  const answerOf = (each: BuildQuestion) => each.answer ?? given[each.id]
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      questions.findIndex((each) => !each.answer)
    )
  )
  const [phase, setPhase] = useState<Phase>("asking")
  const [collapsed, setCollapsed] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const focusComposer = useFocusComposer()

  // Settled before this tab answered the last one: in the chat, or no
  // longer needed. Nothing to fold.
  if (phase === "asking" && questions.every(answerOf)) return null
  if (phase === "gone") return null

  if (phase === "folded") {
    return (
      <Docked name="build-questions" settled>
        {/* It fades for the last 250 ms of its `FOLDED_MS`. */}
        <div
          className="motion-safe:fade-out-0 rounded-[var(--composer-radius,var(--radius-4xl))] border border-border bg-card px-5 py-3 motion-safe:animate-out motion-safe:fill-mode-forwards motion-safe:delay-1250 motion-safe:duration-enter"
          role="status"
        >
          <Done>Thanks, that's everything I needed.</Done>
        </div>
      </Docked>
    )
  }

  const question = questions[index] ?? questions[0]
  if (!question) return null
  const answer = answerOf(question)

  // Saves one answer. Back come the answers now held, with the stored
  // stack's (an answer can close others, as No closes the address
  // question's name), or the words to show.
  const store = async (each: BuildQuestion, sent: Given, now: Answers) => {
    const stored = await send?.({
      conversationId: conversationId ?? "",
      reply: { message_id: messageId, question_id: each.id, answer: sent },
    }).catch(() => FAILED)
    if (typeof stored === "string") return stored
    return {
      ...now,
      ...Object.fromEntries(
        (stored?.questions ?? []).flatMap((one) =>
          one.answer ? [[one.id, one.answer]] : []
        )
      ),
      [each.id]: sent,
    }
  }

  /** After a save: on to the next open question, or fold once all are settled. */
  const onward = (now: Answers, from: number) => {
    setGiven(now)
    const settledNow = (each: BuildQuestion) => each.answer ?? now[each.id]
    const next = nextOpen(questions, (each) => Boolean(settledNow(each)), from)
    if (next === undefined) {
      const said =
        data.kind === "address" ? addressSaid(questions, settledNow) : null
      if (said) aui.thread().append(said)
      setPhase("closing")
      // The buttons go with the fold, so the keyboard goes to the composer.
      setTimeout(() => {
        setPhase("folded")
        focusComposer()
      }, ONWARD_MS)
      setTimeout(() => setPhase("gone"), ONWARD_MS + FOLDED_MS)
    } else {
      // Unless the owner moved on themselves in the pause.
      setTimeout(() => setIndex((at) => (at === from ? next : at)), ONWARD_MS)
    }
  }

  const skip = async () => {
    if (!send || !conversationId || sending) return
    setSending(true)
    setError(null)
    const now = await store(question, { kind: "skipped" }, given)
    setSending(false)
    if (typeof now === "string") setError(now)
    else onward(now, index)
  }

  // One Send sends every open page, in order, and stops at the first that
  // cannot go yet. What was sent before it stays sent.
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!send || !conversationId || sending) return
    setSending(true)
    setError(null)
    let now = given
    for (const [at, each] of questions.entries()) {
      if (each.answer ?? now[each.id]) continue
      const form = document.getElementById(`${id}-${at}`)
      const fields = new FormData(form as HTMLFormElement)
      const parsed = answerValue(each.input, (name) =>
        String(fields.get(name) ?? "")
      )
      const saved =
        "error" in parsed
          ? parsed.error
          : await store(
              each,
              {
                kind: "value",
                value: parsed.value as Extract<
                  Given,
                  { kind: "value" }
                >["value"],
              },
              now
            )
      if (typeof saved === "string") {
        setSending(false)
        // A page after this one not answered yet is next, as after any
        // answer; one before it, or a refusal, is shown with why.
        if (at > index && "error" in parsed) return onward(now, index)
        setGiven(now)
        setIndex(at)
        setError(saved)
        return
      }
      now = saved
    }
    setSending(false)
    onward(now, index)
  }

  const go = (to: number) => {
    setError(null)
    setIndex(to)
  }
  const open = !answer && phase === "asking"

  return (
    <Docked name="build-questions">
      <TrayFrame
        collapsed={collapsed}
        onBack={index > 0 ? () => go(index - 1) : undefined}
        onCollapsedChange={setCollapsed}
        onForward={
          index < questions.length - 1 ? () => go(index + 1) : undefined
        }
        page={{ index, total: questions.length }}
        question={question.text}
        skip={
          open && question.skippable
            ? {
                label: "Skip",
                onSkip: () => void skip(),
                disabled: sending,
              }
            : undefined
        }
        submit={
          open
            ? {
                label: sending ? "Sending" : "Send",
                form: `${id}-${index}`,
                disabled: sending,
              }
            : undefined
        }
      >
        {/* Every open page stays in place, hidden, so going back finds what
            was typed. */}
        {questions.map((each, at) => {
          const settled = answerOf(each)
          return (
            <div hidden={at !== index} key={each.id}>
              {settled ? (
                <Done>{settledLine(each, settled)}</Done>
              ) : (
                <form
                  className="flex flex-col gap-2"
                  id={`${id}-${at}`}
                  noValidate
                  onSubmit={(event) => void submit(event)}
                >
                  <AnswerInputs
                    id={`${id}-${at}`}
                    invalid={at === index && error !== null}
                    spec={each.input}
                    title={each.text}
                  />
                  {at === index && error ? (
                    <p className={FIELD_ERROR} role="alert">
                      {error}
                    </p>
                  ) : null}
                </form>
              )}
            </div>
          )
        })}
      </TrayFrame>
    </Docked>
  )
}

export const BuildQuestionsUI = makeAssistantDataUI<BuildQuestions>({
  name: "build_questions",
  render: BuildQuestionsPart,
})
