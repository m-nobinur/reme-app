import { localMidnight } from "@workspace/ui/lib/zone"
import type { OrgSummary, Workspace } from "./api/types"
import { factsNeeded, questionOf } from "./reminders"

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

/**
 * `today at 15:00`, `tomorrow at 09:00`, in the browser's time zone: the
 * chat renders only in the browser, so this is where the owner reads it.
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
  const time = date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  })
  return `${when} at ${time}`
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
