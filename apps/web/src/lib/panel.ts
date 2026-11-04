import type {
  Activity,
  ActivitySegment,
  ActivityStep,
  BuildSummary,
  Conversation,
} from "@workspace/contracts"
import type { LineBadge } from "@workspace/ui/components/live-panel"
import {
  type CopyContext,
  completedBrief,
  domainStep,
  logoLine,
  minutesLeft,
  needsLine,
  notStarted,
  pageAction,
  pillLine,
  proofOf,
  rowLine,
  type SetupPart,
  type StatusKind,
  segmentKind,
  segmentLine,
  segmentStatus,
  segmentTitle,
  setupTitle,
  stepKind,
  stepName,
  WAITING_HINT,
  wroteToOwner,
} from "@workspace/ui/lib/activity-copy"
import { dayOf } from "@workspace/ui/lib/format"
import type { AttentionItem, Workspace } from "./api/types"
import { assistantOf, leading } from "./briefing"
import { onboardingFor } from "./onboarding"
import { dueLine, upcomingNotes } from "./reminders"
import { ownDomainClaimed } from "./website-checklist"

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
  state: ActivityStep["state"]
  /** The icon the step moves while it is at work. */
  kind: StatusKind
  /** Beside the label: what the step waiting on the owner wants. */
  hint?: string
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
  /** How a build at work is going for time, or null. */
  status: string | null
  /** Folded to one line while something else waits on the owner. */
  quiet: boolean
  steps: StepView[]
  /** The build behind a website or change segment: its plan, photos and Stop. */
  build: BuildSummary | null
}

type Approval = Extract<AttentionItem, { kind: "approval" }>

/** The next task to start, and Google's own sign-in, which starts it. */
export type UpNext = { id: string; text: string; label: string; href: string }

export type Panel = {
  /** The collapsed pill, and the panel's header: what waits on the owner first, else the work. */
  line: Line
  /** The phone's panel button: what waits on the owner, else a build's minutes left; null when idle. */
  badge: LineBadge | null
  /** The first run's segment under way; what finished is in `done`. */
  journey: SegmentView[]
  /**
   * Finished work as it looked in Now, by the ids `done` lists it under: a
   * piece that finishes on screen shows its tick here for a moment first.
   */
  finished: SegmentView[]
  now: SegmentView[]
  /** Jobs waiting on the owner (a DNS change, a payment, a sign-in), as segments. */
  blocked: SegmentView[]
  /** Reviews and questions, answered in the panel. */
  waiting: AttentionItem[]
  /** The review the going-live segment holds while its first step waits. */
  review: Approval | null
  upNext: UpNext | null
  /** Reminders and renewals, soonest first. */
  upcoming: Timed[]
  /** What finished, newest first. */
  done: Timed[]
  /** The last all-clear check-in, once setting up is done: "Last check-in 4:00 PM, all clear". */
  checkIn: string | null
  /** No web address of the owner's own, and none being set up: offer to connect one. */
  connect: boolean
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
      segment.kind !== "onboarding" &&
      all.findIndex((other) => sameWork(other, segment)) === i
  )
  // Setting up finishes a part at a time, each at its own time and in the
  // words its row had in Now.
  const setup = activity.journey
    .filter((segment) => segment.kind === "onboarding")
    .flatMap(setupParts)
    .flatMap((part): Completed[] =>
      part.state === "done"
        ? [
            {
              id: part.id,
              text: setupTitle(part.part, part.steps, true, ctx),
              at: part.at,
              brief: null,
            },
          ]
        : []
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
  return [...setup, ...done, ...proved].sort(
    (a, b) => Date.parse(b.at) - Date.parse(a.at)
  )
}

/** The setting-up steps that are the assistant's and the website's own; the rest are the business's. */
const SETUP_STEPS: Readonly<Record<string, SetupPart>> = {
  assistant: "assistant",
  website: "website",
  photos: "website",
  look: "website",
}

/** Where a part of setting up stands from its steps; null before any is reached. */
function partState(
  steps: readonly ActivityStep[]
): ActivitySegment["state"] | null {
  if (steps.some((s) => s.state === "waiting")) return "waiting"
  if (steps.some((s) => s.state === "now")) return "now"
  if (!steps.some((s) => s.state === "done")) return null
  return steps.every((s) => s.state === "done" || s.state === "skipped")
    ? "done"
    : "now"
}

type Part = {
  part: SetupPart
  /** The business's is the segment's own id, so the row keeps it as before. */
  id: string
  state: ActivitySegment["state"]
  steps: ActivityStep[]
  /** When it finished: its last step's settling, else the segment's time. */
  at: string
}

/** Setting up as the owner meets it: the business, the assistant, the website, each once one of its steps is reached. */
export function setupParts(segment: ActivitySegment): Part[] {
  return (["business", "assistant", "website"] as const).flatMap((part) => {
    const steps = segment.steps.filter(
      (step) => (SETUP_STEPS[step.id] ?? "business") === part
    )
    const state = partState(steps)
    if (!state) return []
    const settled = steps.flatMap((step) => step.at ?? []).sort()
    return [
      {
        part,
        id: part === "business" ? segment.id : `${segment.id}:${part}`,
        state,
        steps,
        at: settled.at(-1) ?? segment.at,
      },
    ]
  })
}

/**
 * The answer to the design tray is stored when the turn that started the
 * build ends, so for a while the panel still read the look as waiting on the
 * owner. A build under way means setting up is over.
 */
function settledOnBuild(activity: Activity): Activity {
  if (
    !activity.journey.some(
      (segment) => segment.kind === "website" && segment.state !== "upcoming"
    )
  ) {
    return activity
  }
  const open = (state: string) => state === "waiting" || state === "now"
  return {
    ...activity,
    journey: activity.journey.map((segment) =>
      segment.kind === "onboarding" && open(segment.state)
        ? {
            ...segment,
            state: "done",
            steps: segment.steps.map((step) =>
              open(step.state) ? { ...step, state: "done" } : step
            ),
          }
        : segment
    ),
  }
}

const running = (segment: ActivitySegment | undefined) =>
  segment?.state === "now" ||
  segment?.state === "waiting" ||
  segment?.state === "failed"

export function panelFor(input: PanelInput): Panel | null {
  const { workspace, business, now, zone } = input
  const { live, host, builds, attention } = workspace
  const activity = settledOnBuild(workspace.activity ?? NO_ACTIVITY)
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
  const elapsedOf = (segment: ActivitySegment) =>
    zone && segment.state === "now"
      ? Math.max(0, (now.getTime() - Date.parse(segment.at)) / 1000)
      : undefined
  const view = (segment: ActivitySegment): SegmentView => {
    const elapsedSeconds = elapsedOf(segment)
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
    // A domain shows one step: what the owner does now, or what is being done for it.
    const domain = segment.kind === "address" || segment.kind === "domain"
    const current = domain
      ? segment.steps
          .filter((s) => s.state === "now" || s.state === "waiting")
          .at(-1)
      : undefined
    const said = domain ? domainStep(segment, ctx) : null
    return {
      id: segment.id,
      kind: segment.kind,
      state: segment.state,
      icon: segmentKind(segment),
      title: segmentTitle(segment, ctx) ?? "",
      working: segmentTitle({ ...segment, state: "now" }, ctx) ?? "",
      line: segmentLine(segment, ctx, {
        ...(until ? { until } : {}),
        ...(doing ? { doing } : {}),
      }),
      status: segmentStatus(segment, elapsedSeconds),
      quiet: false,
      steps:
        current && said
          ? [
              {
                id: current.id,
                label: said,
                state: current.state,
                kind: stepKind(segment, current),
              },
            ]
          : domain
            ? []
            : segment.steps.flatMap((step) => {
                // A step that never applied (buying, for a domain the owner
                // has) is not listed; a question the owner skipped in
                // onboarding is.
                if (step.state === "skipped" && segment.kind !== "onboarding")
                  return []
                const label = stepName(segment, step)
                return label
                  ? [
                      {
                        id: step.id,
                        label,
                        state: step.state,
                        kind: stepKind(segment, step),
                        ...(step.state === "waiting" && { hint: WAITING_HINT }),
                      },
                    ]
                  : []
              }),
      build,
    }
  }

  /** Setting up's parts, each with its topic while it runs and its outcome once done. */
  const setupViews = (segment: ActivitySegment): SegmentView[] => {
    const whole = view(segment)
    return setupParts(segment).map((part) => {
      const ids = new Set(part.steps.map((step) => step.id))
      return {
        ...whole,
        id: part.id,
        state: part.state,
        title: setupTitle(part.part, part.steps, part.state === "done", ctx),
        working: setupTitle(part.part, part.steps, false, ctx),
        steps: whole.steps.filter((step) => ids.has(step.id)),
      }
    })
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
  // browser render agree. The reminders page lists its own reminders. The
  // owner meets a check-in only once it has run.
  const settingUp = journey.some(
    (segment) => segment.kind === "onboarding" && segment.state !== "done"
  )
  const upcoming = zone
    ? rows(
        activity.upcoming.filter(
          (segment) =>
            !notStarted(segment) &&
            segment.kind !== "checkin" &&
            (segment.kind !== "reminder" || page !== "reminders")
        )
      )
    : []
  // Google once nothing has begun on it, and only once the owner has a
  // domain of their own, live or connecting. No time in it, so it needs no
  // zone. Its line is never in the owner's voice: its sign-in.
  const claimed = ownDomainClaimed(activity.standing ?? [], workspace.host)
  const queued = activity.upcoming.find(
    (segment) => notStarted(segment) && segment.kind === "google"
  )
  const upText = queued && rowLine(queued, ctx)
  const upNext: UpNext | null =
    queued && upText && claimed
      ? {
          id: queued.id,
          text: upText,
          label: pageAction("google").label,
          href: "/api/google/start",
        }
      : null
  // A web address the owner said "Not now" to, or never got to, can be
  // connected any time after setting up, unless one is being set up now.
  const addressing = [...activity.now, ...activity.waiting].some(
    (segment) =>
      segment.kind === "address" ||
      segment.kind === "domain" ||
      segment.kind === "purchase"
  )
  const connect = business !== null && !settingUp && !claimed && !addressing

  // A routine check-in that found nothing is no row: during setting up it is
  // not said at all, after it the last one is one quiet line.
  const checkins = activity.done.filter((segment) => segment.kind === "checkin")
  const quiet = new Set(
    checkins
      .filter((segment) => settingUp || !wroteToOwner(segment))
      .map((segment) => segment.id)
  )
  const done = zone
    ? completedOf(workspace, ctx).filter((row) => !quiet.has(row.id))
    : []
  const [lastClear] = checkins.filter((segment) => !wroteToOwner(segment))
  const checkIn =
    zone && lastClear && !settingUp
      ? `Last check-in ${timeOf(lastClear.at, zone, now)}, all clear`
      : null

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
  // The header says one thing and holds it: what waits on the owner first,
  // in the assistant's words ("Ava needs your answer"), then the work at
  // hand ("Ava is building your website"). Getting to know the business is
  // one line for its whole run, a question waiting or not.
  const said = (segment: ActivitySegment | undefined): Line[] => {
    const lead = segment && running(segment) ? pillLine(segment, ctx) : null
    return segment && lead
      ? [{ tone: segment.state === "now" ? "working" : tone, lead }]
      : []
  }
  const owed = [current, ...blocked].filter(
    (segment) => segment?.state === "waiting" && segment.kind !== "onboarding"
  )
  const forOwner: Line[] = owed.flatMap(said)
  if (questions.length) {
    forOwner.unshift({
      tone,
      lead:
        questions.length === 1
          ? needsLine(ctx)
          : `${leading(assistantOf(workspace))} has ${questions.length} questions for you`,
    })
  }
  // A version to publish leads a question, as the most pressing.
  if (approvals.length) {
    forOwner.unshift({
      tone,
      lead: live ? "Your changes" : "Your website",
      detail: live ? "are ready to publish" : "is ready to publish",
    })
  }
  const needed = forOwner.length > 0
  const answers = approvals.length + questions.length + owed.length
  const working = [current, ...activity.now].find(
    (segment) => segment?.state === "now" && segment.kind !== "onboarding"
  )
  const badge: LineBadge | null =
    answers > 0
      ? { kind: "answer", count: answers }
      : working
        ? { kind: "working", minutes: minutesLeft(working, elapsedOf(working)) }
        : null
  const [first] = [
    ...forOwner,
    ...[current, ...activity.now, ...blocked].flatMap(said),
  ]

  const line = ((): Line => {
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

  // While the owner is wanted elsewhere, work at hand folds to one line.
  const shownView = (segment: ActivitySegment) => {
    const each = view(segment)
    return { ...each, quiet: needed && each.state === "now" }
  }
  const parts = current?.kind === "onboarding" ? setupViews(current) : []
  // The design tray's logo round, as its own row under setting up.
  const logo: SegmentView[] = current?.logo
    ? [
        {
          id: "logo",
          kind: "onboarding",
          state: current.logo.status === "drawing" ? "now" : "waiting",
          icon: current.logo.status === "drawing" ? "polishing" : "waiting",
          title: "Your logo",
          working: "Your logo",
          line: logoLine(current.logo),
          status: null,
          quiet: true,
          steps: [],
          build: null,
        },
      ]
    : []
  const before = at === -1 ? journey : journey.slice(0, at)
  return {
    line,
    badge,
    journey: current
      ? current.kind === "onboarding"
        ? [...parts.filter((part) => part.state !== "done"), ...logo]
        : [shownView(current)]
      : [],
    finished: [
      ...parts.filter((part) => part.state === "done"),
      ...before.flatMap((segment) =>
        segment.kind === "onboarding"
          ? setupViews(segment)
          : segment.state === "done"
            ? [view(segment)]
            : []
      ),
      ...activity.done
        .filter((segment) => segmentTitle(segment, ctx))
        .map(view),
    ],
    now: activity.now.map(shownView),
    blocked: blocked.map(view),
    waiting,
    review,
    upNext,
    upcoming,
    done,
    checkIn,
    connect,
    suggestions,
  }
}
