import type { ToolCallMessagePartComponent } from "@assistant-ui/react"
import type { AskableFactKey, AskFactOutput } from "@workspace/contracts"
import {
  Docked,
  TrayFrame,
  TrayNote,
} from "@workspace/ui/components/assistant/question-tray"
import { AnswerInputs } from "@workspace/ui/components/live-panel"
import { answerValue, askable, FACT_INPUTS } from "@workspace/ui/lib/answer"
import { FIELD_ERROR } from "@workspace/ui/lib/card"
import { askFactView } from "@workspace/ui/lib/tool-state"
import { type FormEvent, useId, useState } from "react"

/**
 * One fact onboarding asks for, answered in the question tray with the key's
 * own native inputs. The question is the web's copy for the key; the call
 * carries only the key, whether it may be skipped, and a starting value.
 * Once answered or skipped it shows nothing: the owner's reply after it
 * says what they said, and the next step is a message of its own.
 */
const AskFact: ToolCallMessagePartComponent = (props) => {
  const view = askFactView(props)
  const id = useId()
  const [invalid, setInvalid] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  if (view.state === "answered" || view.state === "skipped") return null
  if (view.state !== "pending") {
    return (
      <TrayNote
        error={view.state === "error" ? view.message : null}
        name="ask-fact"
      />
    )
  }
  const { key, skippable, prefill } = view.input
  const question = askable(key) ? FACT_INPUTS[key].ask : "A question"

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
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
    props.addResult({
      answer: "stated",
      fact: { key, value: parsed.value },
    } as AskFactOutput)
  }

  return (
    <Docked name="ask-fact">
      <TrayFrame
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
        question={question}
        skip={
          skippable
            ? {
                label: "Skip",
                onSkip: () => props.addResult({ answer: "skipped" }),
              }
            : undefined
        }
        submit={{ label: "Submit", form: `${id}-form` }}
      >
        <form
          className="flex flex-col gap-2"
          id={`${id}-form`}
          noValidate
          onSubmit={submit}
        >
          <AnswerInputs
            id={id}
            invalid={invalid !== null}
            prefill={prefill}
            spec={{ kind: "fact", key: key as AskableFactKey }}
            title={question}
          />
          {invalid ? (
            <p className={FIELD_ERROR} role="alert">
              {invalid}
            </p>
          ) : null}
        </form>
      </TrayFrame>
    </Docked>
  )
}
AskFact.displayName = "AskFact"

export { AskFact }
