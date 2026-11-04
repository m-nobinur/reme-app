import type {
  BuildQuestions,
  CosWorkspace,
  OwnerTask,
} from "@workspace/contracts"
import { addressStage } from "@workspace/db"
import { IN_REVIEW, STATE } from "./labels.ts"

/**
 * The per-turn notes built by code from the records (plan §3): what is open,
 * in plain lines, so the model never infers it from the workspace JSON.
 * Every line is our own words over ids and states, never owner text. The
 * chat reads the rows they come from (`turnNotes` in chat.ts), since the
 * CoS's code never reads the conversation's messages (ADR-034).
 */

/** The newest address card: what the owner picked on it, and what it still asks on screen. */
export type AddressCard = {
  answer: "yes" | "no" | "later" | null
  /** The question the card shows now, only when it sits in this conversation. */
  waiting: "have" | "name" | null
}

const ANSWERS = ["yes", "no", "later"] as const

/** The card's state from its stack, as `answerAddress` reads the answer: by place. */
export function cardState(stack: BuildQuestions, here: boolean): AddressCard {
  const [ask, name] = stack.questions
  const value = ask?.answer?.kind === "value" ? String(ask.answer.value) : null
  const way =
    value !== null && ask?.input.kind === "choice"
      ? ask.input.options.indexOf(value)
      : -1
  const answer = ANSWERS[way] ?? null
  const waiting = !here
    ? null
    : !ask?.answer
      ? "have"
      : answer === "yes" && name && !name.answer
        ? "name"
        : null
  return { answer, waiting }
}

/** A date as the owner reads it, such as "Thursday 12 November". */
const day = (at: string, zone: string | null) =>
  new Date(at).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: zone ?? "UTC",
  })

const UNKNOWN = "Whether they have a domain is unknown: ask, never guess."

function addressLine(
  tasks: readonly OwnerTask[],
  card: AddressCard | null,
  now: Date,
  zone: string | null
): string {
  const { stage, name, until } = addressStage(tasks)
  switch (stage) {
    case "live":
      return `Web address: ${name ?? "the website's own address"} is connected.`
    case "connecting":
      return `Web address: ${name} is being connected; the domains list says how far.`
    case "paying":
      return `Web address: ${name} is being bought here and waits for the owner's payment.`
    case "buying_elsewhere":
      return `Web address: the owner is buying ${name} themselves. When they say it's bought, call domain_bought with that name; until then, ask whether they have bought it, never assume.`
    case "bought":
      return `Web address: the owner bought ${name} themselves and the registry shows it; putting the website on it is next (connect_domain once they say yes).`
    case "choosing":
      return "Web address: the owner has no domain and wants one; picking a name is next (find_domain). If they say they bought one, ask which and connect it."
    case "declined":
      return "Web address: the owner said no to an address of their own. Don't offer it again unless they ask."
    case "put_off": {
      const passed = until !== undefined && Date.parse(until) <= now.getTime()
      const chose =
        card?.answer === "later"
          ? "The owner chose Skip for now on the address card"
          : "The owner put it off"
      return `Web address: not settled. ${chose}${until ? (passed ? ", and that date has passed" : `, until ${day(until, zone)}`) : ""}. ${UNKNOWN}`
    }
  }
  if (card?.answer === "yes")
    return "Web address: not settled. The owner said on the card they have a domain; its name is unknown: ask for it, never guess."
  return `Web address: not settled. ${UNKNOWN}`
}

/** The domain states in which the website has its own address, live or being connected. */
const OWN = new Set(["awaiting_dns", "verifying", "active"])

function googleLine(workspace: CosWorkspace, now: Date, zone: string | null) {
  const task = workspace.tasks?.find((t) => t.kind === "google")
  if (task?.state === "done") return "Google: connected."
  if (task?.state === "declined") return "Google: the owner said no."
  if (task?.state === "active") {
    const waits = task.steps.find((s) => s.state === "blocked")
    return `Google: being set up${waits?.note ? `; waiting on the owner (${waits.note})` : ""}.`
  }
  const own = (workspace.domains ?? []).some((d) => OWN.has(d.state))
  if (task?.state === "later" && task.later_until) {
    return Date.parse(task.later_until) > now.getTime()
      ? `Google: put off by the owner until ${day(task.later_until, zone)}.`
      : `Google: put off by the owner; that date has passed${own ? ", so it can be offered once" : ""}.`
  }
  return own
    ? "Google: not connected; it can be offered now the website has its own address."
    : "Google: not connected; it waits for a domain of the website's own."
}

function websiteLine(workspace: CosWorkspace): string {
  const live = workspace.site.live_version !== null
  const building = workspace.builds.filter(
    (b) => !IN_REVIEW.has(STATE[b.state])
  )
  const ready =
    workspace.approvals.length > 0 ||
    workspace.builds.some((b) => IN_REVIEW.has(STATE[b.state]))
  const parts = [
    live ? "published" : ready ? "draft ready, not published" : null,
    live && ready ? "a new draft waits for the owner" : null,
    building.length > 0 ? "a build is under way" : null,
  ].filter(Boolean)
  return `Website: ${parts.length > 0 ? parts.join("; ") : "not built yet"}.`
}

/** Where the card on screen stands, so a reply never points at one that is gone. */
function cardLine(card: AddressCard | null): string {
  if (card?.waiting === "have")
    return "On screen: the address card asks whether the owner has a web address; they answer it there."
  if (card?.waiting === "name")
    return "On screen: the address card asks for the domain's name; they can type it there."
  return "No question card waits on screen: never tell the owner to answer or type on a card."
}

/** Onboarding's steps as the hand-over names them. */
const STEP_WORDS: Record<string, string> = {
  work: "services",
  area: "service area",
  customers: "customers",
  proof: "what sets the business apart",
  quote_form: "quote questions",
  contact: "contact details",
  recap: "the recap",
  assistant: "your name, pronouns and tone",
  website: "whether to build the website",
  look: "the website's look",
}

const CARD_WORDS: Record<NonNullable<AddressCard["answer"]>, string> = {
  yes: "Yes, I have one",
  no: "No, help me get one",
  later: "Skip for now",
}

/**
 * The hand-over note (plan §4): what onboarding settled and what the owner
 * skipped, logged once as a `cos.event` on the first CoS turn after it, so
 * this turn, reflection and compaction all see onboarding.
 */
export function handoverNote(
  steps: readonly { id: string; state: string }[],
  card: AddressCard | null
): string {
  const named = (state: string) =>
    steps.flatMap((s) =>
      s.state === state && STEP_WORDS[s.id] ? [STEP_WORDS[s.id]] : []
    )
  const settled = named("done")
  const skipped = named("skipped")
  return [
    "Hand-over: you onboarded the owner in this conversation before this turn; those messages are not in your history, and the facts hold what they gave.",
    settled.length > 0 ? `Settled: ${settled.join(", ")}.` : null,
    skipped.length > 0
      ? `Skipped by the owner or left for later: ${skipped.join(", ")}.`
      : null,
    card?.answer
      ? `On the address card the owner chose ${CARD_WORDS[card.answer]}.`
      : card
        ? "The owner has not answered the address card."
        : null,
    "What is still open is in each turn's open items note.",
  ]
    .filter(Boolean)
    .join(" ")
}

/** Header of the open items note, with the rule for what it does not know. */
export const OPEN_ITEMS_HEADER =
  "Open items, from the records as this turn began. They outrank anything earlier messages said. Where a line says unknown, ask the owner one short question; never guess a name, a choice or an answer."

/** The open items note (plan §3), built every turn from tasks, card answers, domains, Google, builds and reviews. */
export function openItems(
  workspace: CosWorkspace,
  card: AddressCard | null,
  now: Date = new Date(),
  zone: string | null = null
): string[] {
  const questions = workspace.questions.length
  return [
    OPEN_ITEMS_HEADER,
    `- ${websiteLine(workspace)}`,
    `- ${addressLine(workspace.tasks ?? [], card, now, zone)}`,
    `- ${googleLine(workspace, now, zone)}`,
    ...(questions > 0
      ? [
          `- The Developer has ${questions} open question${questions === 1 ? "" : "s"} for the owner.`,
        ]
      : []),
    `- ${cardLine(card)}`,
  ]
}

/** An owner message about the website's own address: a card reply, or naming a domain. */
const ABOUT_ADDRESS =
  /\b(?:domains?|web ?address|website address|own address)\b|\.(?:co\.uk|uk|com)\b|^(?:Yes, I have one|Yes, it's|No, help me get one)/i
const ABOUT_GOOGLE = /\b(?:google|search console)\b/i

/** Address stages with work under way, where the web-address procedure is certain. */
const UNDER_WAY = new Set([
  "choosing",
  "paying",
  "buying_elsewhere",
  "bought",
  "connecting",
])

/**
 * The procedures state makes certain for this turn (plan §2), by name: the
 * top open item's on the hand-over, the address or Google one when the
 * owner's message is about it or its task is under way, builds while one
 * runs or stopped, reviews while a draft waits, and a scheduled run's own.
 */
export function skillsDue({
  workspace,
  handover = false,
  said = null,
  scheduled = null,
}: {
  workspace: CosWorkspace
  handover?: boolean
  said?: string | null
  scheduled?: string | null
}): string[] {
  const due = new Set<string>(scheduled ? [scheduled] : [])
  const { stage } = addressStage(workspace.tasks ?? [])
  const google = workspace.tasks?.find((t) => t.kind === "google")
  if (handover) due.add(stage === "live" ? "google-search" : "web-address")
  if (
    (said && ABOUT_ADDRESS.test(said)) ||
    UNDER_WAY.has(stage) ||
    (workspace.tips?.length ?? 0) > 0
  )
    due.add("web-address")
  if ((said && ABOUT_GOOGLE.test(said)) || google?.state === "active")
    due.add("google-search")
  const inReview = (b: CosWorkspace["builds"][number]) =>
    IN_REVIEW.has(STATE[b.state])
  if (
    workspace.builds.some((b) => !inReview(b)) ||
    (workspace.stopped?.length ?? 0) > 0
  )
    due.add("builds")
  if (workspace.approvals.length > 0 || workspace.builds.some(inReview))
    due.add("reviews")
  return [...due]
}
