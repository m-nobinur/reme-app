import { useAui, useAuiState } from "@assistant-ui/react"
import { PencilSimpleIcon } from "@phosphor-icons/react"
import { ReopenStep } from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import { createContext, useContext } from "react"

/**
 * What the owner says to go back to an answered step, in their words. The
 * assistant reopens the step's card from it, filled with what they gave.
 */
export const CHANGE_ASK: Record<ReopenStep, string> = {
  "business.name": "I'd like to change the business name",
  "business.offerings": "I'd like to change my services",
  "service_area.text": "I'd like to change the area I cover",
  "business.audience": "I'd like to change who my customers are",
  "business.proof": "I'd like to change what sets us apart",
  industry: "I'd like to change the kind of work I do",
  quote_form: "I'd like to change the quote questions",
  contact: "I'd like to change my contact details",
  assistant: "I'd like to change my assistant",
}

const SetupContext = createContext(false)

/** Whether onboarding is still open, so an answered step can be changed. */
export const SetupOpenProvider = SetupContext.Provider

/** The step a card answered, when it is one the owner can go back to. */
export const reopenable = (step: unknown) => ReopenStep.safeParse(step).data

/**
 * Change, under a card the owner answered during onboarding: one tap says
 * so as their message. Nothing once onboarding is over or for a step that
 * cannot be reopened.
 */
export function ChangeAnswer({ step }: { step: unknown }) {
  const aui = useAui()
  const running = useAuiState((s) => s.thread.isRunning)
  const open = useContext(SetupContext)
  const reopen = reopenable(step)
  if (!open || !reopen) return null
  const ask = CHANGE_ASK[reopen]
  return (
    <Button
      aria-label={ask.replace("I'd like to change", "Change")}
      data-slot="change-answer"
      disabled={running}
      onClick={() => aui.thread().append(ask)}
      size="xs"
      type="button"
      variant="ghost"
    >
      <PencilSimpleIcon aria-hidden data-icon="inline-start" />
      Change
    </Button>
  )
}
