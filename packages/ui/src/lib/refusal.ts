import { UNCONFIRMED } from "@workspace/ui/lib/tool-state"

/**
 * What a refused tool call tells the owner, by the api's code. The api's
 * message can be written for the system ("No assignment with that id in
 * this business."), so it is never shown: a known code gets its line here,
 * and any other gets the tool's own. A refusal that only says the outcome
 * is unknown reads as one, so the owner checks before asking again.
 */
const COPY: Record<string, string> = {
  "change.question_open": "A build is waiting on your answer. Answer it first.",
  "change.build_busy": "A build is finishing. Ask again once it settles.",
  "change.cancelled": "That change was stopped. Ask again to start it.",
  "builds.daily_cap":
    "You have started as many builds as a day allows. Try again tomorrow.",
  "request.not_found": "That question is no longer waiting on you.",
  "answer.already_given": "That question has already been answered.",
  "answer.invalid":
    "That answer does not fit the question. Answer it in the panel.",
  "answer.malformed":
    "That answer does not fit the question. Answer it in the panel.",
  "assignment.not_waiting": "That build is no longer waiting on this answer.",
  "assignment.not_found": "That build is not in your workspace.",
  "reminder.due_past": "A reminder cannot be due in the past.",
  "reminder.due_far": "A reminder can be due at most a year ahead.",
  "reminder.unconfirmed": UNCONFIRMED,
  "preview.unconfigured": "Previews are not available right now.",
}

export function refusalText(code: string | null, fallback: string): string {
  return (code && Object.hasOwn(COPY, code) ? COPY[code] : null) ?? fallback
}
