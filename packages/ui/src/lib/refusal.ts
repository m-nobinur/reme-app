import { UNCONFIRMED } from "@workspace/ui/lib/tool-state"

/**
 * What a refused write tells the owner, by the api's code, in the chat and
 * in the panel alike. The api's message can be written for the system ("No
 * assignment with that id in this business."), so it is never shown: a known
 * code gets its line here, and any other gets the caller's own. A refusal
 * that only says the outcome is unknown reads as one, so the owner checks
 * before asking again.
 */
const COPY: Record<string, string> = {
  "change.build_busy":
    "A build is finishing. Ask again once it is ready for you.",
  "change.cancelled": "That change was stopped. Ask again to start it.",
  "builds.daily_cap":
    "You have started as many builds as a day allows. Try again tomorrow.",
  "request.not_found": "That question is no longer waiting on you.",
  "answer.already_given":
    "That question was already answered, so this answer was not recorded.",
  "answer.invalid":
    "That answer does not fit the question. Check it and send it again.",
  "answer.malformed":
    "That answer does not fit the question. Answer it in the panel.",
  "assignment.not_waiting": "That build is no longer waiting on this answer.",
  "assignment.not_found": "That build is not in your workspace.",
  "reminder.due_past": "A reminder cannot be due in the past.",
  "reminder.due_far": "A reminder can be due at most a year ahead.",
  "reminder.not_found": "That reminder is no longer open.",
  "reminder.unconfirmed": UNCONFIRMED,
  "account.other_members":
    "Other people still belong to this business. Remove them first.",
  "account.not_owner": "Only the owner can delete this account.",
  "preview.unconfigured": "Previews are not available right now.",
  "domain.unavailable":
    "That name isn't free to register any more. Nothing was charged.",
  "domain.buy_unavailable": "Buying a domain isn't available yet.",
  "site.not_published":
    "Publish your website first, then I can buy the name for it. Nothing was charged.",
  "domain.in_use": "That name is already on your website.",
  "domain.too_many_pending":
    "You have several names waiting for payment. Finish or drop one first.",
  "domain.not_awaiting_payment":
    "That name isn't waiting for payment any more.",
  "domain.paid": "That name is already paid for.",
  "domain.not_found":
    "I can't find that purchase any more. Ask me to look again.",
  "domain.not_owner": "Only the business owner can buy a name.",
  "registrar.unavailable":
    "The domain registry isn't answering just now. Nothing was charged. Try again in a minute.",
  "rdap.unavailable":
    "The domain registry isn't answering just now, so I can't check it yet. Try again in a minute.",
  "domain.registrant_invalid":
    "The registration details aren't complete. Edit them and try again.",
  "domain.price_changed":
    "That domain's price has changed, so nothing was charged. Ask me for a fresh price.",
  "rate.limited":
    "Too many changes in a short time. Wait a minute and try again.",
}

export function refusalText(code: string | null, fallback: string): string {
  return (code && Object.hasOwn(COPY, code) ? COPY[code] : null) ?? fallback
}
