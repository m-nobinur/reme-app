import type { ToolCallMessagePartComponent } from "@assistant-ui/react"
import type { AskOpenInput } from "@workspace/contracts"
import {
  ACCENT_RING,
  Docked,
  TrayFrame,
  TrayNote,
} from "@workspace/ui/components/assistant/question-tray"
import { Input } from "@workspace/ui/components/input"
import { askable, FACT_INPUTS } from "@workspace/ui/lib/answer"
import { askOpenView } from "@workspace/ui/lib/tool-state"
import { cn } from "@workspace/ui/lib/utils"
import { type FormEvent, useId, useState } from "react"

/**
 * A question onboarding asks in words, answered in the question tray in the
 * owner's own. The assistant's message asks it; the tray's title is the
 * web's copy for what it is after. Once answered or skipped it shows
 * nothing: the owner's reply after it is what they wrote.
 */

/** Titles for what `ask_open` can be after that has no typed form of its own. */
const OPEN_ASK: Partial<Record<AskOpenInput["about"], string>> = {
  "quote.form": "What do you need to know to quote a job?",
  "business.industry": "What kind of work do you do?",
  "assistant.pronouns": "Which pronouns should your assistant use?",
  "assistant.tone": "How should your assistant sound?",
}

const openQuestion = (about: AskOpenInput["about"]) =>
  OPEN_ASK[about] ?? (askable(about) ? FACT_INPUTS[about].ask : "Your answer")

const AskOpen: ToolCallMessagePartComponent = (props) => {
  const view = askOpenView(props)
  const id = useId()
  const [text, setText] = useState("")
  const [collapsed, setCollapsed] = useState(false)
  if (view.state === "answered" || view.state === "skipped") return null
  if (view.state !== "pending") {
    return (
      <TrayNote
        error={view.state === "error" ? view.message : null}
        name="ask-open"
      />
    )
  }
  const question = openQuestion(view.input.about)
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const said = text.trim()
    if (said) props.addResult({ answer: "stated", text: said })
  }

  return (
    <Docked name="ask-open">
      <TrayFrame
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
        question={question}
        skip={{
          label: "Skip",
          onSkip: () => props.addResult({ answer: "skipped" }),
        }}
        submit={{
          label: "Submit",
          form: `${id}-form`,
          disabled: !text.trim(),
        }}
      >
        <form id={`${id}-form`} noValidate onSubmit={submit}>
          <Input
            aria-label={question}
            autoComplete="off"
            className={cn(
              "h-12 rounded-xl border-border bg-card px-3.5 md:text-sm",
              ACCENT_RING
            )}
            maxLength={1000}
            onChange={(event) => setText(event.currentTarget.value)}
            placeholder="Your answer…"
            value={text}
          />
        </form>
      </TrayFrame>
    </Docked>
  )
}
AskOpen.displayName = "AskOpen"

export { AskOpen }
