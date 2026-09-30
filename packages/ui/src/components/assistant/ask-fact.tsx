import type { ToolCallMessagePartComponent } from "@assistant-ui/react"
import { CheckCircleIcon } from "@phosphor-icons/react"
import type { AskableFactKey, AskFactOutput } from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import { AnswerInputs } from "@workspace/ui/components/live-panel"
import {
  useFocusWhenIdle,
  useRevealWaiting,
} from "@workspace/ui/hooks/use-reveal-waiting"
import { answerValue, askable, FACT_INPUTS } from "@workspace/ui/lib/answer"
import { factText } from "@workspace/ui/lib/facts"
import { askFactView } from "@workspace/ui/lib/tool-state"
import { type FormEvent, useId, useRef, useState } from "react"

/**
 * One fact onboarding asks for, answered in the transcript with the key's
 * own native inputs. The question is the web's copy for the key; the call
 * carries only the key, whether it may be skipped, and a starting value.
 * Once answered it stays as the question and what the owner said, so the
 * transcript reads the same after a reload.
 */
const AskFact: ToolCallMessagePartComponent = (props) => {
  const view = askFactView(props)
  const id = useId()
  const waiting = view.state === "pending"
  const running = useRevealWaiting(waiting)
  const formRef = useRef<HTMLFormElement>(null)
  useFocusWhenIdle(waiting, running, formRef)
  const [invalid, setInvalid] = useState<string | null>(null)
  const question =
    view.key && askable(view.key) ? FACT_INPUTS[view.key].ask : "A question"

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (view.state !== "pending") return
    const { key } = view.input
    if (!askable(key)) return
    const form = new FormData(event.currentTarget)
    const parsed = answerValue({ kind: "fact", key }, (name) =>
      String(form.get(name) ?? "")
    )
    if ("error" in parsed) {
      setInvalid(parsed.error)
      return
    }
    setInvalid(null)
    const output = {
      answer: "stated",
      fact: { key, value: parsed.value },
    } as AskFactOutput
    props.addResult(output)
  }

  return (
    <div className="my-3 flex max-w-md flex-col gap-2" data-slot="ask-fact">
      <p className="font-medium" id={`${id}-question`}>
        {question}
      </p>
      {view.state === "pending" ? (
        <form
          aria-labelledby={`${id}-question`}
          className="flex flex-col gap-3"
          noValidate
          onSubmit={submit}
          ref={formRef}
        >
          <AnswerInputs
            id={id}
            invalid={invalid !== null}
            prefill={view.input.prefill}
            spec={{ kind: "fact", key: view.input.key as AskableFactKey }}
            title={question}
          />
          {invalid ? (
            <p className="text-[0.8125rem] text-destructive" role="alert">
              {invalid}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" type="submit">
              Save
            </Button>
            {view.input.skippable ? (
              <Button
                onClick={() => props.addResult({ answer: "skipped" })}
                size="sm"
                type="button"
                variant="outline"
              >
                Skip for now
              </Button>
            ) : null}
          </div>
        </form>
      ) : view.state === "answered" ? (
        <p className="flex items-center gap-2 text-sm">
          <CheckCircleIcon
            aria-hidden
            className="size-4 shrink-0 text-primary"
          />
          <span className="min-w-0 break-words">
            {factText(view.fact.key, view.fact.value)}
          </span>
        </p>
      ) : (
        <p
          className={
            view.state === "error"
              ? "text-destructive text-sm"
              : "text-muted-foreground text-sm"
          }
        >
          {view.state === "skipped"
            ? "Skipped. You can add it later under Business."
            : view.state === "cancelled"
              ? "Not answered. You sent a message instead."
              : view.message}
        </p>
      )}
    </div>
  )
}
AskFact.displayName = "AskFact"

export { AskFact }
