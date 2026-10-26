import type {
  ActivitySegment,
  ActivityStep,
  FactValueKey,
} from "@workspace/contracts"
import { phoneText } from "@workspace/starter-site/phone"
import {
  currentStep,
  designDone,
  ended,
  factValue,
  has,
  mode,
  type Onboarding,
  oldDesign,
  voiceOf,
} from "./onboarding.ts"

/**
 * Where onboarding stands, step by step. The planner's checklist and the
 * activity panel both read it, so the panel can never tick a step the
 * planner thinks is open, or the other way round. Pure functions of the
 * facts and the conversation's cards: state, never sentences.
 */

/** The design choices a build needs when the owner is on the four-card flow. */
export const DESIGN: readonly FactValueKey[] = [
  "site.template",
  "site.palette",
  "site.font",
  "site.pages",
]

/** How often an optional detail is asked in all, so an owner who defers it is left alone. */
export const OPTIONAL_ASKS = 1

/** The onboarding segment's steps, in the order the panel lists them. */
export const ONBOARDING_STEPS = [
  "work",
  "area",
  "customers",
  "proof",
  "quote_form",
  "contact",
  "assistant",
  "website",
  "look",
] as const

type StepId = (typeof ONBOARDING_STEPS)[number]

/** The script's step that is open now, as the panel's step it belongs to. */
const STEP_OF: Record<string, StepId> = {
  "business.offerings": "work",
  industry: "work",
  "business.name": "work",
  "service_area.text": "area",
  "business.audience": "customers",
  "business.proof": "proof",
  contact: "contact",
  assistant: "assistant",
  build_for_me: "website",
  quote_form: "quote_form",
  "quote.form": "quote_form",
  design: "look",
}

type Settled = { state: "done" | "skipped"; value?: string }

/** What a step shows as its value: one line, the owner's words. */
const cut = (words: string) =>
  words.length > 120 ? `${words.slice(0, 119)}…` : words
const upper = (words: string) => words.charAt(0).toUpperCase() + words.slice(1)
const done = (value?: string): Settled => ({
  state: "done",
  ...(value ? { value: cut(value) } : {}),
})
const skipped: Settled = { state: "skipped" }

/** Each step the owner has settled, with the value as they would say it; absent while open. */
function settled(
  o: Onboarding,
  asked: Readonly<Record<string, number | undefined>>
): Partial<Record<StepId, Settled>> {
  const fact = (key: FactValueKey) => has(o, key)
  const offerings = factValue(o.facts, "business.offerings")?.items
  const phone = factValue(o.facts, "business.phone")?.e164
  const email = factValue(o.facts, "business.email")?.address
  const audience = factValue(o.facts, "business.audience")?.text
  const proof = factValue(o.facts, "business.proof")?.text
  const area = factValue(o.facts, "service_area.text")?.text
  const quote = factValue(o.facts, "quote.form")?.fields
  const look = voiceOf(o)
  const manual = mode(o) === "manual"
  const out: Partial<Record<StepId, Settled>> = {}
  if (fact("business.industry") && offerings) {
    out.work = done(upper(offerings.join(", ")))
  }
  if (area) out.area = done(area)
  if (phone && email) out.contact = done(`${phoneText(phone)}, ${email}`)
  const name = factValue(o.facts, "assistant.name")?.name
  if (name && fact("assistant.pronouns") && fact("assistant.tone")) {
    out.assistant = done(name)
  }
  if (quote) {
    out.quote_form = done(
      `${quote.length} ${quote.length === 1 ? "question" : "questions"}`
    )
  } else if (o.closed.includes("quote_form")) out.quote_form = skipped
  // The customers are optional: a detail never given is skipped once the
  // owner skipped it, once it was asked, or once they moved on to the quote
  // questions, which come after it. The skip is read from its card, since
  // the panel reads no asked counts: on a return to the quote form it showed
  // the skipped customers open (2026-10-25).
  const movedOn = Boolean(out.quote_form || out.contact)
  const passed = (key: FactValueKey) =>
    o.passed.includes(key) || (asked[key] ?? 0) >= OPTIONAL_ASKS || movedOn
  if (audience) out.customers = done(audience)
  else if (passed("business.audience")) out.customers = skipped
  // What sets them apart is optional too, and settles the same way.
  if (proof) out.proof = done(proof)
  else if (passed("business.proof")) out.proof = skipped
  if (mode(o) === "assistant") out.website = done()
  if (manual) {
    // The owner skipped the website: nothing the build needs is asked.
    out.website = skipped
    out.look = skipped
  } else {
    if (oldDesign(o) ? DESIGN.every(fact) : designDone(o)) {
      out.look = done(
        [look.palette, look.direction ?? look.ownLook]
          .filter(Boolean)
          .join(", ")
      )
    }
  }
  return out
}

/**
 * Every step with where it stands: `done` or `skipped` once settled, then
 * the one open now as `now` (or `waiting` when a question for the owner is
 * open in the chat), the rest `next`. The list is the same nine steps for
 * every run from its first moment; only their states move.
 *
 * The step open now is the one the script is on, so the panel and the
 * planner agree on it. Once the build is under way nothing is open.
 */
export function onboardingSteps(
  o: Onboarding,
  asked: Readonly<Record<string, number | undefined>> = o.asked ?? {},
  waiting = false,
  /** The script step or fact the waiting question is about. */
  asking?: string
): ActivityStep[] {
  const have = settled(o, asked)
  const over = ended(o)
  const open = ONBOARDING_STEPS.filter((id) => !have[id])
  const scripted = STEP_OF[currentStep(o)?.id ?? ""]
  // While a question waits, the step it asks about is the open one; a
  // question the steps do not name falls to the first open step, so the
  // panel always shows something being asked.
  const about = waiting ? STEP_OF[asking ?? ""] : scripted
  const now = over ? undefined : about && open.includes(about) ? about : open[0]
  return ONBOARDING_STEPS.map((id): ActivityStep => {
    const was = have[id]
    if (was)
      return { id, state: was.state, ...(was.value && { value: was.value }) }
    if (over) return { id, state: "skipped" }
    return { id, state: id === now ? (waiting ? "waiting" : "now") : "next" }
  })
}

/**
 * The onboarding segment the activity read puts first in the journey.
 * `waiting` is whether a question for the owner is open in the chat; `at`
 * is when onboarding started, or finished once it is done.
 */
export function onboardingSegment(
  o: Onboarding,
  at: string,
  waiting = false,
  asking?: string
): ActivitySegment {
  const steps = onboardingSteps(o, o.asked ?? {}, waiting, asking)
  const finished = steps.every(
    (s) => s.state === "done" || s.state === "skipped"
  )
  const business = factValue(o.facts, "business.name")?.name ?? o.orgName
  return {
    id: "onboarding",
    kind: "onboarding",
    state: finished ? "done" : waiting ? "waiting" : "now",
    steps,
    at,
    ...(business && { names: { business: cut(business) } }),
  }
}
