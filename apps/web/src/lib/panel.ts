import type { BuildSummary, Conversation } from "@workspace/contracts"
import { BUILD_STAGES } from "@workspace/ui/components/live-panel"
import { currentRow, WORKING } from "@workspace/ui/lib/build-state"
import { factLabel } from "@workspace/ui/lib/facts"
import type { AttentionItem, Workspace } from "./api/types"
import { askerOf, assistantOf, digestOf } from "./briefing"
import { onboardingFor } from "./onboarding"
import { dayOf, dueLine, upcomingNotes } from "./reminders"
import { stoppedOf } from "./stopped"

/**
 * What the floating panel says, from what the frame has already read: the
 * page the owner is on, the live workspace, the conversations and the last
 * 30 days of reports. Pure, so every sentence it can say is tested here, and
 * null when there is nothing worth a panel on this page.
 */

/** The pages the panel words itself for. Any other /app page is "elsewhere". */
type PanelPage =
  | "home"
  | "chat"
  | "onboarding"
  | "website"
  | "reminders"
  | "approvals"
  | "elsewhere"

/** A next step the app can take. The app draws each as a link or a button. */
export type Suggestion =
  | { kind: "name-business" }
  | { kind: "onboarding"; id: string }
  | { kind: "start-website" }
  | { kind: "request-change" }
  | { kind: "visit-site"; host: string; url: string }
  | { kind: "set-reminder" }

/** Something with a time: what is coming up, or what just happened. */
export type Timed = { id: string; text: string; at: string }

export type Line = {
  tone: "working" | "live" | "idle"
  lead: string
  detail?: string
  /** The step a working build is on, of how many. */
  progress?: { done: number; total: number }
}

export type Panel = {
  /** The collapsed pill, and the panel's header. */
  line: Line
  /** One or two sentences for this page and this state. */
  headline: string[]
  /** What a new business still needs before its first build. */
  steps: { label: string; done: boolean }[] | null
  /** The build being worked on, and the goals queued behind it. */
  build: BuildSummary | null
  queued: string[]
  /** Reviews and questions answered in the panel. */
  waiting: AttentionItem[]
  /** Publishes and alerts from the last day, newest first. */
  latest: Timed[]
  /** Closing reviews and questions, and reminders due within a day, soonest first. */
  upcoming: Timed[]
  /** At most three. */
  suggestions: Suggestion[]
}

export type PanelInput = {
  /** The leaf route's id, as the router names it. */
  route: string | undefined
  /** The conversation in the address, if any. */
  conversation: string | undefined
  workspace: Workspace
  /** The organisation's name, or null before the business has one. */
  business: string | null
  conversations: Conversation[] | null
  /** Reports and alerts from `/activity`, or null when that read failed. */
  activity: AttentionItem[] | null
  names: Record<string, string>
  now: Date
  /** The reader's zone, or null on the server, when no time of day is said. */
  zone: string | null
}

const DAY = 86_400_000

/** The pages where getting started is the thing to talk about. */
const STARTING: ReadonlySet<PanelPage> = new Set([
  "home",
  "chat",
  "onboarding",
  "website",
])

/** Which page the route is, with the getting-started chat told apart. */
export function pageOf(
  route: string | undefined,
  conversation: string | undefined,
  onboarding: string | null
): PanelPage {
  switch (route) {
    case "/app/_conversation/":
      return "home"
    case "/app/_conversation/c/$id":
      return conversation && conversation === onboarding ? "onboarding" : "chat"
    case "/app/website":
      return "website"
    case "/app/reminders":
      return "reminders"
    case "/app/approvals":
      return "approvals"
    default:
      return "elsewhere"
  }
}

/** The build the panel shows as being worked on, which its anchor marks. */
export const currentBuild = (builds: BuildSummary[]) =>
  builds.find((build) => build.state !== "queued") ?? builds.at(-1)

/** `version 4`, or what the build makes when it has no number yet. */
const buildName = (build: BuildSummary, live: number | null) => {
  const version = build.revision?.version
  return version
    ? `version ${version}`
    : live
      ? "a new version"
      : "your first version"
}

/** `9:30 am`, in `zone`: the time part of `dueLine`. */
const timeOf = (at: string, zone: string, now: Date) =>
  dueLine(at, zone, now).split(", ").at(-1) ?? ""

/** `Today, 9:30 am` mid-sentence: `today, 9:30 am`. A weekday keeps its capital. */
const midSentence = (when: string) =>
  when.replace(/^(Today|Tomorrow)/, (day) => day.toLowerCase())

/** What closes next: reviews and questions with an expiry. */
const expiries = (waiting: AttentionItem[]): Timed[] =>
  waiting.flatMap((item) =>
    item.expiresAt
      ? [
          {
            id: item.id,
            at: item.expiresAt,
            text:
              item.kind === "approval"
                ? `Your review of version ${item.version} closes`
                : `The question about ${item.title.toLowerCase()} closes`,
          },
        ]
      : []
  )

/**
 * The reminders page's sentence: what is due today, else when the next one
 * is. Without the reader's zone there is no "today", so it counts.
 */
function remindersSentence(
  workspace: Workspace,
  now: Date,
  zone: string | null
): string | null {
  const ahead = upcomingNotes(workspace.reminderNotes, now.getTime())
  const [first] = ahead
  if (!first) return null
  if (!zone) {
    return ahead.length === 1
      ? "One reminder ahead."
      : `${ahead.length} reminders ahead.`
  }
  const dated = ahead.filter((note) => note.due_at !== null)
  const today = dated.filter(
    (note) => dayOf(new Date(note.due_at ?? ""), zone) === dayOf(now, zone)
  )
  const [soonest] = today
  if (soonest?.due_at) {
    const at = timeOf(soonest.due_at, zone, now)
    return today.length === 1
      ? `One reminder today, at ${at}.`
      : `${today.length} reminders today, the next at ${at}.`
  }
  const [next] = dated
  if (next?.due_at) {
    return `Nothing due today. The next reminder is ${midSentence(dueLine(next.due_at, zone, now))}.`
  }
  return ahead.length === 1
    ? "One reminder, with no time set."
    : `${ahead.length} reminders, none with a time set.`
}

export function panelFor(input: PanelInput): Panel | null {
  const { workspace, business, names, now, zone } = input
  const { live, host, url, builds, attention, missingFacts } = workspace
  const onboarding = business
    ? onboardingFor(workspace, input.conversations)
    : null
  const page = pageOf(input.route, input.conversation, onboarding)
  const fresh = live === null && builds.length === 0
  const assistant = assistantOf(workspace)

  // The approvals page lists every review itself, so the panel leaves them
  // to it rather than draw each one twice.
  const waiting = attention.filter(
    (item) =>
      item.kind === "question" ||
      (item.kind === "approval" && page !== "approvals")
  )
  const approvals = waiting.flatMap((item) =>
    item.kind === "approval" ? [item] : []
  )
  const questions = waiting.flatMap((item) =>
    item.kind === "question" ? [item] : []
  )
  const build = currentBuild(builds) ?? null
  const working = builds.find((each) => WORKING.has(each.state))

  // Times of day wait for the reader's zone, so the server's HTML and the
  // first browser render agree.
  const soon = zone
    ? upcomingNotes(workspace.reminderNotes, now.getTime()).flatMap((note) =>
        note.due_at &&
        page !== "reminders" &&
        Date.parse(note.due_at) - now.getTime() <= DAY
          ? [{ id: note.id, text: note.title, at: note.due_at }]
          : []
      )
    : []
  const upcoming = [...expiries(waiting), ...soon].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at)
  )
  const reports = input.activity ?? []
  const latest =
    zone && page === "home"
      ? reports
          .filter((item) => now.getTime() - Date.parse(item.raisedAt) <= DAY)
          .sort((a, b) => Date.parse(b.raisedAt) - Date.parse(a.raisedAt))
          .slice(0, 3)
          .map((item) => ({ id: item.id, text: item.title, at: item.raisedAt }))
      : []

  // Where the panel has something to say. Getting started belongs to the
  // chat and, while it runs, the Website page; every other page shows the
  // panel only while something is under way, waiting or due.
  const busy = builds.length > 0 || waiting.length > 0 || upcoming.length > 0
  const reminders = remindersSentence(workspace, now, zone)
  const shown: Record<PanelPage, boolean> = {
    home: true,
    chat: true,
    onboarding: true,
    website: business !== null && (!fresh || onboarding !== null),
    reminders: busy || reminders !== null,
    approvals: busy,
    elsewhere: busy,
  }
  if (!shown[page]) return null

  // Only facts still missing are listed, so no step is ever shown done.
  const steps =
    business && fresh && STARTING.has(page)
      ? [
          ...missingFacts.map((key) => ({
            label: factLabel(key),
            done: false,
          })),
          { label: "Build your first version", done: false },
        ]
      : null

  // A build that failed, while nothing has happened since: the owner is told
  // why, and the suggestions below are how to try again or ask for changes.
  const stopped = stoppedOf(workspace)

  const digest = () =>
    digestOf({ ...workspace, attention: waiting }, names, zone ? now : null)

  const headline = ((): string[] => {
    if (!business) {
      return [`Name your business and ${assistant} can start on its website.`]
    }
    if (page === "reminders" && reminders) return [reminders]
    if (stopped) return stopped
    if (steps) {
      const intro = onboarding
        ? `Getting ${business} ready for its first website.`
        : `${business} has no website yet.`
      // The steps below name each detail, so this only counts them.
      if (missingFacts.length) {
        return [
          intro,
          missingFacts.length === 1
            ? `One detail to go before ${assistant} can build it.`
            : `${missingFacts.length} details to go before ${assistant} can build it.`,
        ]
      }
      return [
        intro,
        onboarding
          ? `${assistant} has every detail it needs. Finish getting started to build the site.`
          : `Ask ${assistant} in a chat to build one for you to review.`,
      ]
    }
    if (page === "chat" || page === "onboarding") {
      if (working?.state === "release_candidate") {
        return [`${assistant} is publishing ${buildName(working, live)} now.`]
      }
      if (working) {
        return [
          `${assistant} is building ${buildName(working, live)} while you chat.`,
          // The stepper below says the stage; this says what the owner can do.
          "Keep chatting. Nothing goes live until you approve it.",
        ]
      }
      const [approval] = approvals
      if (approval) {
        return [
          `Version ${approval.version} is ready for your review.`,
          "Approve it here, or say what to change.",
        ]
      }
      const [question] = questions
      if (question) {
        return [
          `${askerOf(question, names)} asked about ${question.title.toLowerCase()}.`,
          "Answer here and the build carries on.",
        ]
      }
      if (live) {
        return [
          `Version ${live} of your website is live.`,
          `Ask ${assistant} to change a page, check what needs you, or set a reminder.`,
        ]
      }
    }
    if (page === "website") {
      if (live) {
        const newest = reports
          .filter((item) => item.kind === "report")
          .sort((a, b) => Date.parse(b.raisedAt) - Date.parse(a.raisedAt))[0]
        const published =
          newest && zone
            ? ` Published ${midSentence(dueLine(newest.raisedAt, zone, now))}.`
            : ""
        const [approval] = approvals
        return [
          `Version ${live} is live${host ? ` at ${host}` : ""}.${published}`,
          working
            ? `${assistant} is building ${buildName(working, live)}. You review it before it replaces this one.`
            : approval
              ? `Version ${approval.version} is ready to replace it once you approve.`
              : `Ask for a change and ${assistant} builds a new version for you to review.`,
        ]
      }
      if (working) {
        return [
          `${assistant} is building your first version.`,
          "You review it before it goes live.",
        ]
      }
    }
    return digest()
  })()

  const line = ((): Line => {
    const tone = live ? "live" : "idle"
    // An approved version is no longer being built: "Version 1, publishing".
    if (working?.state === "release_candidate" && working.revision?.version) {
      return {
        tone: "working",
        lead: `Version ${working.revision.version},`,
        detail: "publishing",
      }
    }
    if (working) {
      // A full build names the step it is on and how far through them it is,
      // which the minimised pill keeps in view.
      const rows = working.lane === "quick" ? [] : (working.activity ?? [])
      const at = currentRow(rows)
      const step = rows[at]
      return {
        tone: "working",
        lead: working.revision?.version
          ? `Building version ${working.revision.version},`
          : live
            ? "Building a new version,"
            : "Building your first version,",
        detail:
          working.state === "planning" && working.blueprint?.awaiting
            ? "waiting for your review"
            : step
              ? step.label.toLowerCase()
              : BUILD_STAGES[working.state].note.toLowerCase().slice(0, -1),
        ...(step ? { progress: { done: at + 1, total: rows.length } } : {}),
      }
    }
    const [approval] = approvals
    if (approval) {
      return {
        tone,
        lead:
          approvals.length === 1
            ? `Version ${approval.version} is ready`
            : `${approvals.length} versions are ready`,
        detail: "for your review",
      }
    }
    const [question] = questions
    if (question) {
      return questions.length === 1
        ? {
            tone,
            lead: askerOf(question, names),
            detail: "has a question for you",
          }
        : { tone, lead: `${questions.length} questions`, detail: "for you" }
    }
    if (page === "reminders" && reminders) {
      return { tone, lead: reminders.replace(/\.$/, "") }
    }
    if (!business)
      return { tone, lead: "Name your business", detail: "to get started" }
    if (stopped) return { tone, lead: "The build stopped" }
    if (steps && onboarding) {
      return {
        tone,
        lead: "Getting started,",
        detail: missingFacts.length
          ? `${missingFacts.length} ${missingFacts.length === 1 ? "detail" : "details"} to go`
          : "your details are in",
      }
    }
    if (live) {
      return page === "website"
        ? {
            tone,
            lead: `Version ${live} is live`,
            ...(host ? { detail: `at ${host}` } : {}),
          }
        : { tone, lead: "Your website is live", detail: `on version ${live}` }
    }
    return workspace.open
      ? { tone, lead: "Your first website", detail: "is under way" }
      : { tone, lead: "Let's get your website started" }
  })()

  const suggestions: Suggestion[] = []
  if (!business) {
    suggestions.push({ kind: "name-business" })
  } else if (page === "reminders") {
    // Reminders are set in a chat; the page has no form of its own.
    suggestions.push({ kind: "set-reminder" })
  } else if (steps) {
    if (!onboarding) suggestions.push({ kind: "start-website" })
    else if (page !== "onboarding") {
      suggestions.push({ kind: "onboarding", id: onboarding })
    }
  } else if (live) {
    // A waiting review has its own Ask for changes; the Website page has
    // its own Request changes and link.
    const reviewing = attention.some((item) => item.kind === "approval")
    if (!reviewing && page !== "website") {
      suggestions.push({ kind: "request-change" })
    }
    if (host && url && page !== "website")
      suggestions.push({ kind: "visit-site", host, url })
  }

  return {
    line,
    headline,
    steps,
    build,
    queued: builds
      .filter((each) => each !== build && each.state === "queued")
      .map((each) => each.goal),
    waiting,
    latest,
    upcoming,
    suggestions: suggestions.slice(0, 3),
  }
}
