import { factLabel } from "@workspace/ui/lib/facts"
import { formatTime } from "@workspace/ui/lib/format"
import { localMidnight } from "@workspace/ui/lib/zone"
import type { OrgSummary, Workspace } from "./api/types"
import { factsNeeded, questionOf } from "./reminders"

/**
 * What the empty conversation opens with: one line on where things stand, the
 * business and its site on the composer's chip, and up to four things to
 * ask. All of it is read from the workspace, never written by a model, so it
 * costs nothing and says nothing the rows do not.
 */
export type Briefing = {
  line: string | null
  suggestions: { prompt: string }[]
}

const NOTHING: Briefing = { line: null, suggestions: [] }

/**
 * `today at 3:00 PM`, `tomorrow at 9:00 AM`, in the browser's time zone: the
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
  return `${when} at ${formatTime(date)}`
}

/**
 * What the owner calls their assistant: the name they gave it, else "your
 * assistant". Never the product name, which is not who they are talking to.
 */
export const assistantOf = (workspace: Workspace | null) =>
  workspace?.assistantName?.trim() || "your assistant"

/** `assistantOf` opening a sentence: "Ellie", or "Your assistant". */
export const leading = (assistant: string) =>
  assistant.charAt(0).toUpperCase() + assistant.slice(1)

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
  const assistant = leading(assistantOf(workspace))
  const questions = attention.filter((item) => item.kind === "question")

  // A site waiting on Publish is still an open build, but it is ready; the
  // updates under the composer carry Publish.
  const site = live
    ? "Your website is live."
    : approval
      ? "Your website is ready to go live."
      : building
        ? `${assistant} is building your website.`
        : open
          ? "Your website is in progress."
          : "You don't have a website yet."

  // Each reminder rule sharpens the line for its own kind, so one line never
  // says the same thing twice: a closing review replaces "ready to publish",
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
    next = `Publish ${live ? "your latest changes" : "it"} by ${due(expiring.expires_at, now)}.`
  } else if (approval && live) {
    next = "Your latest changes are ready to publish."
  } else if (waiting) {
    next = `${assistant} is still waiting for your answer about ${waiting.title.toLowerCase()}.`
  } else if (questions.length === 1) {
    next = `${assistant} has a question for you.`
  } else if (questions.length > 1) {
    next = `You have ${questions.length} questions to answer.`
  } else if (unpublished && !approval) {
    next = "Your latest changes aren't published yet."
  } else if (facts) {
    next = `${assistant} still needs ${factsNeeded(facts.keys)}.`
  } else if (building && live) {
    next = `${assistant} is working on your changes.`
  }

  // What waits on the owner first, then the build, then what to do next.
  // Only with no build at all is the business new: a paused or waiting build
  // would be superseded by "Build my website".
  const fresh = !live && !open && !approval
  const suggestions: string[] = []
  if (approval) {
    suggestions.push(
      live ? "What did you change?" : "What's on my new website?"
    )
  }
  if (questions.length > 0) {
    suggestions.push("What do you need from me?")
  }
  if (unpublished && !approval) {
    suggestions.push("Why aren't my changes live yet?")
  }
  if (building) {
    suggestions.push(
      live
        ? "How are my changes coming along?"
        : "How's my website coming along?"
    )
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
      "What's on my website now?",
      "I want to change something on my website",
      "Set a reminder for me"
    )
  }

  return {
    line: next ? `${site} ${next}` : site,
    suggestions: suggestions.slice(0, 4).map((prompt) => ({ prompt })),
  }
}
