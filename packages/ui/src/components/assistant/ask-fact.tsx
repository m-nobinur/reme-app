import type { ToolCallMessagePartComponent } from "@assistant-ui/react"
import type { AskableFactKey, AskFactOutput } from "@workspace/contracts"
import {
  Docked,
  TrayFrame,
  TrayNote,
  useTabDraft,
} from "@workspace/ui/components/assistant/question-tray"
import { AnswerInputs } from "@workspace/ui/components/live-panel"
import {
  answerValue,
  askable,
  FACT_INPUTS,
  saidInChat,
} from "@workspace/ui/lib/answer"
import { FIELD_ERROR } from "@workspace/ui/lib/card"
import { askFactView } from "@workspace/ui/lib/tool-state"
import { type FocusEvent, type FormEvent, useId, useState } from "react"

/**
 * One fact onboarding asks for, answered in the question tray with the key's
 * own native inputs. The question is the web's copy for the key; the call
 * carries only the key, whether it may be skipped, and a starting value.
 * Once answered or skipped it shows nothing: the owner's reply after it
 * says what they said, and the next step is a message of its own. A fact
 * that is one plain line of text has no card at all: the owner says it in
 * the composer.
 */
const AskFact: ToolCallMessagePartComponent = (props) => {
  const view = askFactView(props)
  const id = useId()
  const [invalid, setInvalid] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState(false)
  const { draft, save } = useTabDraft<Record<string, string>>(
    `fact:${props.toolCallId}`,
    {}
  )
  const restore = (form: HTMLFormElement | null) => {
    if (!form || form.dataset.restored) return
    form.dataset.restored = "true"
    for (const [name, value] of Object.entries(draft)) {
      const field = form.elements.namedItem(name)
      if (field instanceof HTMLInputElement && !field.value) field.value = value
    }
  }
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
  // A fact the owner just says is answered in the composer.
  if (askable(key) && saidInChat(key)) return null
  const question = askable(key) ? FACT_INPUTS[key].ask : "A question"

  // Leaving a filled field checks it; an empty one waits for Submit.
  const checkOnLeave = (event: FocusEvent<HTMLFormElement>) => {
    if (!askable(key) || !(event.target instanceof HTMLInputElement)) return
    if (!event.target.value.trim()) return
    const form = new FormData(event.currentTarget)
    const parsed = answerValue({ kind: "fact", key }, (name) =>
      String(form.get(name) ?? "")
    )
    setInvalid("error" in parsed ? parsed.error : null)
  }

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
          onBlur={checkOnLeave}
          onChange={(event) =>
            save(
              Object.fromEntries(
                [...new FormData(event.currentTarget)].map(([name, value]) => [
                  name,
                  String(value),
                ])
              )
            )
          }
          onSubmit={submit}
          ref={restore}
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
