import { localMidnight } from "@workspace/ui/lib/zone"
import type { AttentionItem, OrgSummary, Workspace } from "./api/types"
import { factsNeeded, questionOf, upcomingNotes } from "./reminders"

/**
 * What the empty conversation opens with: one line on where things stand, the
 * business and its site on the composer's chip, and up to three things to
 * ask. All of it is read from the workspace, never written by a model, so it
 * costs nothing and says nothing the rows do not.
 */
export type Briefing = {
  line: string | null
  context: { name: string; status: string; live: boolean } | null
  suggestions: { prompt: string }[]
}

const NOTHING: Briefing = { line: null, context: null, suggestions: [] }

/** `15:00`, on the browser's clock. */
const clock = (date: Date) =>
  date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })

/**
 * `today at 15:00`, `tomorrow at 09:00`, in the browser's time zone: the
 * chat renders only in the browser, and the panel says it only once the
 * browser's clock is known, so this is where the owner reads it.
 */
function due(at: string, now: Date): string {
  const date = new Date(at)
  const days = Math.round(
    (localMidnight(date) - localMidnight(now)) / 86_400_000
  )
  const when =
    days <= 0
      ? "today"
      : days === 1
        ? "tomorrow"
        : `on ${date.toLocaleDateString("en-GB", { weekday: "long" })}`
  return `${when} at ${clock(date)}`
}

export function briefingOf(
  org: OrgSummary | null,
  workspace: Workspace | null,
  now = new Date()
): Briefing {
  if (!org || !workspace) {
    return NOTHING
  }
  const { live, building, open, attention, derivedReminders } = workspace
  const approval = attention.find((item) => item.kind === "approval")
  const approvals = attention.filter((item) => item.kind === "approval").length
  const questions = attention.filter((item) => item.kind === "question")

  const site = live
    ? `v${live} is live.`
    : building
      ? "Your first version is being built."
      : open
        ? "Your first version is under way."
        : "You have no website yet."

  // Each reminder rule sharpens the line for its own kind, so one line never
  // says the same thing twice: a closing review replaces "ready to approve",
  // an old question replaces the question count.
  const expiring = derivedReminders
    .flatMap((reminder) =>
      reminder.rule === "approval_expiring" ? [reminder] : []
    )
    .sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at))[0]
  const waiting = derivedReminders
    .flatMap((reminder) =>
      reminder.rule === "question_waiting"
        ? (questionOf(attention, reminder) ?? [])
        : []
    )
    .at(0)
  const unpublished = derivedReminders.find(
    (reminder) => reminder.rule === "preview_unpublished"
  )
  const facts = derivedReminders.find(
    (reminder) => reminder.rule === "facts_missing"
  )

  let next: string | null = null
  if (expiring) {
    next = `Your review of v${expiring.version} expires ${due(expiring.expires_at, now)}.`
  } else if (approval) {
    next =
      approvals === 1
        ? `Version ${approval.version} is ready for you to approve.`
        : `${approvals} versions are ready for you to approve.`
  } else if (waiting) {
    next = `${waiting.raisedBy}'s question about ${waiting.title.toLowerCase()} is still waiting on you.`
  } else if (questions.length === 1) {
    next = `${questions[0]?.raisedBy} has one question for you.`
  } else if (questions.length > 1) {
    next = `${questions.length} questions are waiting on you.`
  } else if (unpublished) {
    next = `Version ${unpublished.version} is ready but not published.`
  } else if (facts) {
    next = `Reme still needs ${factsNeeded(facts.keys)}.`
  } else if (building && live) {
    next = "A change is being built."
  }

  const suggestions: string[] = []
  if (approval) {
    suggestions.push(`What changed in version ${approval.version}?`)
  }
  if (questions.length > 0) {
    suggestions.push("What do you need from me?")
  }
  if (building) {
    suggestions.push("How is the build going?")
  }
  if (live) {
    suggestions.push("What is on my website now?")
  } else if (!open && !approval) {
    // Only with no build at all: a paused or waiting one would be superseded.
    suggestions.push("Build my website")
  }

  return {
    line: next ? `${site} ${next}` : site,
    context: {
      name: org.name,
      status: live
        ? `site live on v${live}`
        : building
          ? "first version building"
          : open
            ? "first version under way"
            : "no site yet",
      live: live !== null,
    },
    suggestions: suggestions.slice(0, 3).map((prompt) => ({ prompt })),
  }
}

/** Who raised an item: the directory's name when the reader has one. */
export const askerOf = (item: AttentionItem, names: Record<string, string>) =>
  (item.raisedById && names[item.raisedById]) || item.raisedBy

/** A title as the end of a sentence: its own stop, or a full stop. */
const ended = (text: string) => (/[.?!]$/.test(text) ? text : `${text}.`)

/**
 * The panel's opening sentences, as Reme would say them to the owner: what
 * today holds, what waits on them, then where the site stands. With nothing
 * waiting it says so and offers what to ask for next. `now` is null while
 * the reader's clock is unknown (the server's render): nothing is said about
 * today then, so the server's HTML and the first browser render agree.
 */
export function digestOf(
  workspace: Workspace,
  names: Record<string, string>,
  now: Date | null
): string[] {
  const { attention, live, building, open, derivedReminders } = workspace
  const approvals = attention.flatMap((item) =>
    item.kind === "approval" ? [item] : []
  )
  const questions = attention.flatMap((item) =>
    item.kind === "question" ? [item] : []
  )
  const dated = upcomingNotes(workspace.reminderNotes, now?.getTime()).filter(
    (note) => note.due_at !== null
  )
  const today = now
    ? dated.filter(
        (note) =>
          localMidnight(new Date(note.due_at ?? "")) === localMidnight(now)
      )
    : []
  const facts = derivedReminders.find(
    (reminder) => reminder.rule === "facts_missing"
  )

  const waiting: string[] = []
  const [next] = today
  if (now && next?.due_at) {
    waiting.push(
      today.length === 1
        ? `You have a reminder ${due(next.due_at, now)}: ${ended(next.title)}`
        : `You have ${today.length} reminders today. The next is at ${clock(new Date(next.due_at))}: ${ended(next.title)}`
    )
  }
  const [approval] = approvals
  if (approval) {
    waiting.push(
      approvals.length === 1
        ? `Version ${approval.version} of your website is ready for you to review below.`
        : `${approvals.length} versions of your website are ready for you to review below.`
    )
  }
  const [question] = questions
  if (question) {
    waiting.push(
      questions.length === 1
        ? `${askerOf(question, names)} asked about ${question.title.toLowerCase()}. Answer it below.`
        : `Your team has ${questions.length} questions for you below.`
    )
  } else if (facts) {
    // A question is usually the build asking for the same fact.
    waiting.push(`Reme still needs ${factsNeeded(facts.keys)}.`)
  }

  const site = live
    ? `Your website is live on version ${live}.`
    : building
      ? "Reme is building your first website now."
      : open
        ? "Your first website is under way."
        : "Ask Reme in the chat to build your website."

  if (waiting.length) return [...waiting, site].slice(0, 3)
  // A dated reminder may fall today, which only the browser can say.
  if (!now && dated.length) return [site]
  return [
    "You're all caught up. Nothing needs you right now.",
    site,
    ...(live
      ? [
          "Ask Reme in the chat to change something on your website, or to set a reminder.",
        ]
      : []),
  ]
}
