import { factLabel } from "@workspace/ui/lib/facts"
import { localMidnight } from "@workspace/ui/lib/zone"
import type { AttentionItem, OrgSummary, Workspace } from "./api/types"
import { factsNeeded, questionOf, upcomingNotes } from "./reminders"

/**
 * What the empty conversation opens with: one line on where things stand, the
 * business and its site on the composer's chip, and up to four things to
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

  // What waits on the owner first, then the build, then what to do next.
  // Only with no build at all is the business new: a paused or waiting build
  // would be superseded by "Build my website".
  const fresh = !live && !open && !approval
  const suggestions: string[] = []
  if (approval) {
    suggestions.push(`What changed in version ${approval.version}?`)
  }
  if (questions.length > 0) {
    suggestions.push("What do you need from me?")
  }
  if (unpublished && !approval) {
    suggestions.push(`Why is version ${unpublished.version} not live yet?`)
  }
  if (building) {
    suggestions.push("How is the build going?")
  }
  if (fresh) {
    suggestions.push("Build my website")
  }
  if (facts) {
    suggestions.push(
      // Named only while it is short: a new business is missing six.
      facts.keys.length > 2
        ? "Add my business details"
        : `Add my ${new Intl.ListFormat("en-GB").format(
            facts.keys.map((key) => factLabel(key).toLowerCase())
          )}`
    )
  }
  if (fresh) {
    suggestions.push("Let me tell you about my business")
  }
  if (live) {
    suggestions.push(
      "What is on my website now?",
      "I want to change something on my website",
      "Set a reminder for me"
    )
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
    suggestions: suggestions.slice(0, 4).map((prompt) => ({ prompt })),
  }
}

/** Who raised an item: the directory's name when the reader has one. */
export const askerOf = (item: AttentionItem, names: Record<string, string>) =>
  (item.raisedById && names[item.raisedById]) || item.raisedBy

/**
 * The panel's opening lines, two at most: what Reme is doing, then what the
 * owner should do next. With nothing to do it says so in one line. `now` is
 * null while the reader's clock is unknown (the server's render): nothing is
 * said about today then, so the server's HTML and the first browser render
 * agree.
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

  // What waits on the owner, most pressing first, with how many items each covers.
  const needs: { text: string; count: number }[] = []
  const [soonest] = today
  if (soonest?.due_at) {
    const at = clock(new Date(soonest.due_at))
    needs.push({
      text:
        today.length === 1
          ? `${soonest.title.replace(/[.?!]+$/, "")} at ${at}.`
          : `${today.length} reminders today, the next at ${at}.`,
      count: today.length,
    })
  }
  const [approval] = approvals
  if (approval) {
    needs.push({
      text:
        approvals.length === 1
          ? `Version ${approval.version} is ready to review.`
          : `${approvals.length} versions are ready to review.`,
      count: approvals.length,
    })
  }
  const [question] = questions
  if (question) {
    needs.push({
      text:
        questions.length === 1
          ? `${askerOf(question, names)} asked about ${question.title.toLowerCase()}.`
          : `${questions.length} questions are waiting for you.`,
      count: questions.length,
    })
  } else if (facts) {
    // A question is usually the build asking for the same fact.
    needs.push({ text: `Reme needs ${factsNeeded(facts.keys)}.`, count: 1 })
  }

  const doing = building
    ? live
      ? "Reme is updating your website."
      : "Reme is building your website."
    : null
  const total = needs.reduce((sum, need) => sum + need.count, 0)
  const count = (n: number, more = "") =>
    `${n} ${more}${n === 1 ? "thing needs" : "things need"} you.`

  if (doing) {
    const [only] = needs
    if (!only) return [doing]
    return [doing, needs.length === 1 ? only.text : count(total)]
  }
  const [first, second] = needs
  if (first && second) {
    return needs.length === 2
      ? [first.text, second.text]
      : [first.text, count(total - first.count, "more ")]
  }
  if (first) return [first.text]

  const site = live
    ? `Your site is live on version ${live}.`
    : open
      ? "Your website is under way."
      : "Tell Reme about your business to start your website."
  if (!live && !open) return [site]
  // A dated reminder may fall today, which only the browser can say.
  return !now && dated.length ? [site] : [`All caught up. ${site}`]
}
