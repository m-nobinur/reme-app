import type {
  Activity,
  ActivitySegment,
  ActivityStep,
  BuildSummary,
  Conversation,
} from "@workspace/contracts"
import {
  type CopyContext,
  completedBrief,
  notStarted,
  pageAction,
  pillLine,
  proofOf,
  rowLine,
  type StatusKind,
  segmentKind,
  segmentLine,
  segmentTitle,
  stepKind,
  stepLabel,
} from "@workspace/ui/lib/activity-copy"
import { dayOf } from "@workspace/ui/lib/format"
import type { AttentionItem, Workspace } from "./api/types"
import { assistantOf, leading } from "./briefing"
import { onboardingFor } from "./onboarding"
import { dueLine, upcomingNotes } from "./reminders"
import { ownDomainLive } from "./website-checklist"

/**
 * What the floating panel says, from what the frame has already read: the
 * page the owner is on, the live workspace and its activity, and the
 * conversations. Pure, so every sentence it can say is tested here, and null
 * when there is nothing worth a panel on this page. The words come from
 * `activity-copy`; this file only chooses which.
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

/** Something with a time: what is coming up, or what finished. */
export type Timed = { id: string; text: string; at: string }

/** Finished work, with a one-line brief for the Tasks page. */
export type Completed = Timed & { brief: string | null }

export type Line = {
  tone: "working" | "live" | "idle"
  lead: string
  detail?: string
}

/** One step of a segment, in the owner's words. */
export type StepView = {
  id: string
  label: string
  /** The label without its count, when it has one: what a screen reader hears once per step. */
  said?: string
  state: ActivityStep["state"]
  /** The icon the step moves while it is at work. */
  kind: StatusKind
}

/** One segment as the panel draws it: a header and its fixed steps. */
export type SegmentView = {
  id: string
  kind: ActivitySegment["kind"]
  state: ActivitySegment["state"]
  icon: StatusKind
  /** The title for where it stands: the done title once done. */
  title: string
  /** The working title, which a segment that just finished keeps until its steps fold. */
  working: string
  /** The muted line under the title, or null. */
  line: string | null
  steps: StepView[]
  /** The build behind a website or change segment: its plan, photos and Stop. */
  build: BuildSummary | null
}

type Approval = Extract<AttentionItem, { kind: "approval" }>

/** The next task not started, and the one button that starts it in the chat. */
/** The next task to start: a line the owner sends, or Google's own sign-in. */
export type UpNext = { id: string; text: string; label: string } & (
  | { ask: string }
  | { href: string }
)

export type Panel = {
  /** The collapsed pill, and the panel's header. */
  line: Line
  /**
   * Every job at work or waiting, then a version or question for the owner,
   * when there are two or more: the header gives each a turn. Else `[line]`.
   */
  lines: Line[]
  /** The first run's segment under way; what finished is in `done`. */
  journey: SegmentView[]
  now: SegmentView[]
  /** Jobs waiting on the owner (a DNS change, a payment, a sign-in), as segments. */
  blocked: SegmentView[]
  /** Reviews and questions, answered in the panel. */
  waiting: AttentionItem[]
  /** The review the going-live segment holds while its first step waits. */
  review: Approval | null
  upNext: UpNext | null
  /** Reminders, renewals and the next check-in, soonest first. */
  upcoming: Timed[]
  /** What finished, newest first. */
  done: Timed[]
  /** The top segment's next action, and the site once live. */
  suggestions: Suggestion[]
}

export type PanelInput = {
  /** The leaf route's id, as the router names it. */
  route: string | undefined
  /** The conversation in the address, if any. */
  conversation: string | undefined
  workspace: Workspace
  /** The organisation's id, which picks a stable wording, or null before there is one. */
  orgId: string | null
  /** The organisation's name, or null before the business has one. */
  business: string | null
  conversations: Conversation[] | null
  now: Date
  /** The reader's zone, or null on the server, when no time of day is said. */
  zone: string | null
}

const NO_ACTIVITY: Activity = {
  journey: [],
  now: [],
  waiting: [],
  upcoming: [],
  done: [],
}

/** Reviews and questions are answered from `attention`, so their segments are not drawn twice. */
const ANSWERED_IN_PANEL: ReadonlySet<ActivitySegment["kind"]> = new Set([
  "review",
  "question",
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

/** `9:30 am`, in `zone`: the time part of `dueLine`. */
const timeOf = (at: string, zone: string, now: Date) =>
  dueLine(at, zone, now).split(", ").at(-1) ?? ""

/** `Today, 9:30 AM` mid-sentence: `today, 9:30 AM`. A weekday keeps its capital. */
const midSentence = (when: string) =>
  when.replace(/^(Today|Tomorrow)/, (day) => day.toLowerCase())

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

/** A reminder row is its own title, which only the workspace holds. */
const rowTitle = (workspace: Workspace, segment: ActivitySegment) =>
  segment.kind === "reminder"
    ? (workspace.reminderNotes.find(
        (note) => segment.id === `reminder:${note.id}`
      )?.title ??
      workspace.attention.find(
        (item) =>
          item.kind === "reminder" && segment.id === `reminder:${item.id}`
      )?.title ??
      null)
    : null

/**
 * One piece of work: a publish is listed by the feed and by where the site
 * stands, under two ids, and so is a domain, as its address task and as its
 * standing row.
 */
const sameWork = (a: ActivitySegment, b: ActivitySegment) =>
  a.id === b.id ||
  (a.kind === "golive" && b.kind === "golive" && a.at === b.at) ||
  (a.names?.domain !== undefined && a.names.domain === b.names?.domain)

/**
 * Finished work, newest first, each once: the first run's finished
 * segments, the last day's, and where the site stands (its latest publish,
 * address, Google), which keeps older work in view. A task still open earns
 * a row for its furthest done step, dated by when that step moved.
 */
export function completedOf(
  workspace: Workspace,
  ctx: CopyContext
): Completed[] {
  const activity = workspace.activity ?? NO_ACTIVITY
  const finished = [
    ...activity.done,
    // Latest first, so a tie in time still reads newest first.
    ...[...activity.journey].reverse(),
    ...(activity.standing ?? []),
  ].filter(
    (segment, i, all) =>
      segment.state === "done" &&
      all.findIndex((other) => sameWork(other, segment)) === i
  )
  const done = finished.flatMap((segment): Completed[] => {
    const text = rowLine(segment, ctx, rowTitle(workspace, segment))
    return text
      ? [
          {
            id: segment.id,
            text,
            at: segment.at,
            brief: completedBrief(segment, ctx),
          },
        ]
      : []
  })
  const proved = (activity.standing ?? []).flatMap((segment): Completed[] => {
    const proof = segment.state === "done" ? null : proofOf(segment, ctx)
    return proof?.at
      ? [
          {
            id: `${segment.id}:proof`,
            text: proof.text,
            at: proof.at,
            brief: null,
          },
        ]
      : []
  })
  return [...done, ...proved].sort(
    (a, b) => Date.parse(b.at) - Date.parse(a.at)
  )
}

const running = (segment: ActivitySegment | undefined) =>
  segment?.state === "now" ||
  segment?.state === "waiting" ||
  segment?.state === "failed"

export function panelFor(input: PanelInput): Panel | null {
  const { workspace, business, now, zone } = input
  const { live, host, builds, attention } = workspace
  const activity = workspace.activity ?? NO_ACTIVITY
  const onboarding = business
    ? onboardingFor(workspace, input.conversations)
    : null
  const page = pageOf(input.route, input.conversation, onboarding)
  const fresh = live === null && builds.length === 0
  const ctx: CopyContext = {
    seed: input.orgId ?? "",
    assistant: workspace.assistantName,
  }

  /** A segment in the owner's words, with its times in the reader's zone once known. */
  const view = (segment: ActivitySegment): SegmentView => {
    const elapsedSeconds =
      zone && segment.state === "now"
        ? Math.max(0, (now.getTime() - Date.parse(segment.at)) / 1000)
        : undefined
    const until =
      zone && segment.deadline ? timeOf(segment.deadline, zone, now) : undefined
    // The first run builds the newest build; a change is named for its
    // build by the api (`change:<assignment>`).
    const build =
      segment.kind === "website"
        ? (builds[0] ?? null)
        : segment.kind === "change"
          ? (builds.find(
              (each) => segment.id === `change:${each.assignment_id}`
            ) ?? null)
          : null
    const doing = build?.activity?.find((row) => row.now)?.label
    return {
      id: segment.id,
      kind: segment.kind,
      state: segment.state,
      icon: segmentKind(segment),
      title: segmentTitle(segment, ctx) ?? "",
      working: segmentTitle({ ...segment, state: "now" }, ctx) ?? "",
      line: segmentLine(segment, ctx, {
        ...(elapsedSeconds === undefined ? {} : { elapsedSeconds }),
        ...(until ? { until } : {}),
        ...(doing ? { doing } : {}),
      }),
      steps: segment.steps.flatMap((step) => {
        // A step that never applied (buying, for a domain the owner has)
        // is not listed; a question the owner skipped in onboarding is.
        if (step.state === "skipped" && segment.kind !== "onboarding") return []
        const label = stepLabel(
          segment,
          step,
          build?.activity?.find((row) => row.id === step.id)?.items
        )
        const { count: _count, ...plain } = step
        const said = stepLabel(segment, plain)
        return label
          ? [
              {
                id: step.id,
                label,
                ...(said && said !== label ? { said } : {}),
                state: step.state,
                kind: stepKind(segment, step),
              },
            ]
          : []
      }),
      build,
    }
  }

  // The journey: the segment under way, its finished ones under Completed.
  // A segment not yet started shows only once the one before it is done, so
  // nothing claims to run before it does.
  const { journey } = activity
  const at = journey.findIndex((segment) => segment.state !== "done")
  const next = at === -1 ? undefined : journey[at]
  const current =
    next && (next.state !== "upcoming" || at > 0) ? next : undefined

  // The approvals page lists every review itself, so the panel leaves them
  // to it rather than draw each one twice.
  const review =
    page !== "approvals" &&
    current?.kind === "golive" &&
    current.state === "waiting"
      ? (attention.find(
          (item): item is Approval =>
            item.kind === "approval" &&
            item.request.assignment_id === builds[0]?.assignment_id
        ) ?? null)
      : null
  const waiting = attention.filter(
    (item) =>
      item.kind === "question" ||
      (item.kind === "approval" &&
        page !== "approvals" &&
        item.id !== review?.id)
  )
  const approvals = waiting.filter((item) => item.kind === "approval")
  const questions = waiting.filter((item) => item.kind === "question")
  const blocked = activity.waiting.filter(
    (segment) => !ANSWERED_IN_PANEL.has(segment.kind)
  )

  const rows = (segments: ActivitySegment[]): Timed[] =>
    segments.flatMap((segment) => {
      const text = rowLine(segment, ctx, rowTitle(workspace, segment))
      return text ? [{ id: segment.id, text, at: segment.at }] : []
    })
  // Times wait for the reader's zone, so the server's HTML and the first
  // browser render agree. The reminders page lists its own reminders.
  // A check-in means nothing to an owner still answering setup questions.
  const settingUp = journey.some(
    (segment) => segment.kind === "onboarding" && segment.state !== "done"
  )
  const upcoming = zone
    ? rows(
        activity.upcoming.filter(
          (segment) =>
            !notStarted(segment) &&
            (segment.kind === "reminder"
              ? page !== "reminders"
              : segment.kind !== "checkin" || !settingUp)
        )
      )
    : []
  // The address before Google, as the owner meets them. No time in it, so it
  // needs no zone.
  const unstarted = activity.upcoming.filter(notStarted)
  const queued =
    unstarted.find((segment) => segment.kind === "address") ?? unstarted[0]
  const upText = queued && rowLine(queued, ctx)
  // Google is never a line in the owner's voice: its sign-in, and only once
  // their own domain is live.
  const google = queued?.kind === "google"
  const upNext: UpNext | null =
    queued &&
    upText &&
    (!google || ownDomainLive(activity.standing ?? [], workspace.host))
      ? {
          id: queued.id,
          text: upText,
          ...(google
            ? { label: pageAction("google").label, href: "/api/google/start" }
            : pageAction("own")),
        }
      : null
  const done = zone ? completedOf(workspace, ctx) : []

  // Where the panel has something to say. Getting started belongs to the
  // chat and, while it runs, the Website page; every other page shows the
  // panel only while something is under way, waiting or due.
  const busy =
    builds.length > 0 ||
    waiting.length > 0 ||
    upcoming.length > 0 ||
    upNext !== null ||
    activity.now.length > 0 ||
    blocked.length > 0 ||
    running(current)
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

  const tone = live ? "live" : "idle"
  // A job at work or waiting on the owner is the news, in the assistant's
  // own words: "Reme is building your website". Every one of them, so two
  // jobs at once each get a turn in the header.
  const jobs = [current, ...activity.now, ...blocked]
    .filter(running)
    .flatMap((segment): Line[] => {
      const said = segment ? pillLine(segment, ctx) : null
      return segment && said
        ? [{ tone: segment.state === "now" ? "working" : tone, lead: said }]
        : []
    })
  const forOwner: Line[] = []
  if (approvals.length) {
    forOwner.push({
      tone,
      lead: live ? "Your changes" : "Your website",
      detail: live ? "are ready to publish" : "is ready to publish",
    })
  }
  const [question] = questions
  if (question) {
    forOwner.push(
      questions.length === 1
        ? {
            tone,
            lead: leading(assistantOf(workspace)),
            detail: "has a question for you",
          }
        : { tone, lead: `${questions.length} questions`, detail: "for you" }
    )
  }
  const turns = [...jobs, ...forOwner].filter(
    (each, i, all) => all.findIndex((other) => other.lead === each.lead) === i
  )

  const line = ((): Line => {
    const [first] = turns
    if (first) return first
    if (page === "reminders" && reminders) {
      return { tone, lead: reminders.replace(/\.$/, "") }
    }
    if (!business)
      return { tone, lead: "Name your business", detail: "to get started" }
    if (live) {
      return {
        tone,
        lead: "Your website is live",
        ...(host && page === "website" ? { detail: `at ${host}` } : {}),
      }
    }
    return workspace.open
      ? { tone, lead: "Your website", detail: "is in progress" }
      : { tone, lead: "Let's get your website started" }
  })()

  // The top segment's next action. Getting started goes on in its own chat;
  // with no journey under way yet, the owner starts it. Home without a
  // business is the naming form itself, so it offers no link to it.
  const suggestions: Suggestion[] = []
  if (!business) {
    if (page !== "home") suggestions.push({ kind: "name-business" })
  } else if (current?.kind === "onboarding" || (!current && fresh)) {
    if (onboarding && page !== "onboarding") {
      suggestions.push({ kind: "onboarding", id: onboarding })
    } else if (!onboarding && !current) {
      suggestions.push({ kind: "start-website" })
    }
  }

  return {
    line,
    lines: turns.length > 1 ? turns : [line],
    journey: current ? [view(current)] : [],
    now: activity.now.map(view),
    blocked: blocked.map(view),
    waiting,
    review,
    upNext,
    upcoming,
    done,
    suggestions,
  }
}
