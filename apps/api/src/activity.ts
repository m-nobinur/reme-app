import type {
  Activity,
  ActivitySegment,
  ActivityStep,
  AddressDetail,
  AssignmentState,
  AttentionItem,
  BuildSummary,
  OwnerTask,
  Reminder,
  TaskStepState,
  WorkspaceStatus,
} from "@workspace/contracts"
import { type OrgScopedDb, readTasks, sql } from "@workspace/db"
import { STAGES } from "./workspace.ts"

/**
 * The owner's activity view (AV2): every job as a segment with fixed steps,
 * built from the rows the workspace read already holds plus one statement
 * for the domain, Google, heartbeat and first publish rows. State only: the
 * web writes every word (`packages/ui/src/lib/activity-copy.ts`).
 *
 * The body carries no clock, so the workspace etag still matches between
 * polls: every `at` is a stored time, and `now` only decides which group a
 * segment falls in.
 *
 * shortcut: no `turn` segment. An open CoS turn is the latest `cos.context`
 * of the open conversation with no `cos.turn` after it, which is a scan of
 * that session's events on every poll; the chat already shows a running
 * turn. Add it when a turn row or an indexed open-turn read exists.
 */

type Approval = Extract<AttentionItem, { kind: "approval" }>
type Question = Extract<AttentionItem, { kind: "question" }>
type Due = Extract<AttentionItem, { kind: "reminder" }>
type Logged = Extract<AttentionItem, { kind: "report" | "alert" }>
type Segment = ActivitySegment
type Step = ActivityStep

/** A bought domain as `readActivityRows` selects it, for its renewal; the rest of a domain is its task's. */
export type DomainRow = {
  id: string
  name: string
  registration: { expires_at?: string } | null
}

/** Google's last read and what the last 28 days of searches brought. */
export type SearchRow = {
  /** Search Console properties Reme holds for the org. */
  properties: number
  synced_at: string | null
  clicks: number
  impressions: number
}

export type HeartbeatRow = {
  /** Null while the job is paused. */
  next: string | null
  /** The newest run in the last day. */
  last: { at: string; outcome: "ok" | "skipped" | "failed" } | null
}

export type ActivityRows = {
  /** When the org was made: the `at` of a journey segment nothing has started. */
  since: string | Date
  domains: DomainRow[]
  search: SearchRow
  heartbeat: HeartbeatRow | null
  /** The site's first publish, and the build it published. */
  first_live: { at: string; assignment_id: string | null } | null
  /** When the site last published, or null before the first time. */
  live_at: string | null
  /** The org's owner tasks, newest first (`readTasks`). */
  tasks: OwnerTask[]
}

/** A day back from `now`, as SQL: the window "Done today" reads. */
const dayBefore = (now: Date) =>
  sql`${now.toISOString()}::timestamptz - interval '24 hours'`

/**
 * The rows only the activity view reads, in one statement from the org's
 * own row: its bought domains by `domains_org_state_idx`, Google's last read
 * and its 28 days of searches ending at the newest stored day (Google's data
 * runs a few days behind, so the window is not "today"), the heartbeat's
 * newest run by `job_runs_pkey`, and the first publish by
 * `deployments_site_config_version_key`. The owner tasks are a second
 * statement, pipelined beside it.
 *
 * shortcut: the heartbeat row is found by kind with no index on
 * `scheduled_jobs (org_id, kind)`, a scan of a small table; add the index
 * when the table grows past a few thousand rows.
 */
export async function readActivityRows(
  db: OrgScopedDb,
  now: Date
): Promise<ActivityRows> {
  const [[row], tasks] = await Promise.all([
    db.execute<Omit<ActivityRows, "tasks">>(sql`
    select o.created_at as since,
      (select coalesce(json_agg(d), '[]'::json) from (
        select id, name, registration
        from domains where state = 'active' and origin = 'purchased'
        order by created_at desc limit 10) d) as domains,
      (select json_build_object(
        'properties', (select count(*) from search_properties)::int,
        'synced_at', (select max(last_synced_at) from search_properties),
        'clicks', coalesce(sum(clicks), 0)::int,
        'impressions', coalesce(sum(impressions), 0)::int)
        from search_daily
        where date > (select max(date) from search_daily) - 28) as search,
      (select json_build_object(
        'next', case when j.paused_at is null then j.next_run_at end,
        'last', (select json_build_object('at', r.run_at, 'outcome', r.outcome)
          from job_runs r where r.job_id = j.id and r.run_at > ${dayBefore(now)}
          order by r.run_at desc limit 1))
        from scheduled_jobs j where j.kind = 'heartbeat'
        order by j.created_at limit 1) as heartbeat,
      (select json_build_object('at', d.created_at, 'assignment_id', r.assignment_id)
        from deployments d join site_revisions r on r.id = d.revision_id
        where d.site_id = o.id order by d.config_version limit 1) as first_live,
      (select d.created_at from deployments d
        where d.site_id = o.id order by d.config_version desc limit 1) as live_at
    from orgs o limit 1`),
    readTasks(db),
  ])
  if (!row) throw new Error("the org's own row is not visible")
  return { ...row, tasks }
}

// ---------------------------------------------------------------------------
// The fixed steps of each kind, in order. Never added or removed. The
// website's are AV3's `STAGES`, read only inside functions, since
// workspace.ts imports this file.

export const GOLIVE_STEPS = ["approval", "publishing", "loads"] as const
export const CHANGE_STEPS = [
  "understanding",
  "making",
  "checking",
  "ready",
] as const

/** Where a change stands, by the build stage it is on. */
const CHANGE_OF_STAGE: Record<string, number> = {
  // A quick edit's own steps.
  edit: 1,
  check: 2,
  preview: 2,
  planning: 0,
  photos: 1,
  writing: 1,
  polishing: 1,
  checking: 2,
  ready: 3,
}

/** Where a change stands, by state, when it has no stage rows (the quick lane). */
const CHANGE_AT: Partial<Record<AssignmentState, number>> = {
  queued: 0,
  briefing: 0,
  planning: 0,
  implementing: 1,
  revising: 1,
  validating: 2,
  repairing: 2,
}

/** From the preview on: the build is made, and what is left is the owner's review. A review that lapsed parks it in `blocked_on_approval`. */
const MADE: readonly AssignmentState[] = [
  "preview_ready",
  "awaiting_review",
  "release_candidate",
  "blocked_on_approval",
]

/** A build stopped on something only the owner can give: an answer, or more budget. */
const OWNER_HOLDS: readonly AssignmentState[] = [
  "blocked_on_information",
  "paused",
]

const HOUR = 3_600_000
const DAY = 24 * HOUR

const iso = (at: string | Date) => new Date(at).toISOString()

/** Steps before `here` done, `here` in `state`, the rest next; `here` past the end is all done. */
export const along = (
  ids: readonly string[],
  here: number,
  state: "now" | "waiting" = "now"
): Step[] =>
  ids.map((id, i) => ({
    id,
    state: i < here ? "done" : i === here ? state : "next",
  }))

const groupOf = (state: AssignmentState): Segment["state"] =>
  MADE.includes(state)
    ? "done"
    : OWNER_HOLDS.includes(state)
      ? "waiting"
      : "now"

// ---------------------------------------------------------------------------
// Builds

/** The first build's stages from its `activity` rows, with their counts. */
export function websiteSteps(build: BuildSummary): Step[] {
  const rows = build.activity ?? []
  if (rows.length === 0) return along(STAGES, -1)
  const held = OWNER_HOLDS.includes(build.state)
  return rows.map((r) => ({
    id: r.id,
    state: r.skipped
      ? "skipped"
      : r.now
        ? held
          ? "waiting"
          : "now"
        : r.done >= r.total
          ? "done"
          : "next",
    ...(r.total > 1 ? { count: { done: r.done, total: r.total } } : {}),
  }))
}

/** A later build as four steps: understanding, making, checking, ready. */
export function changeSegment(
  build: BuildSummary,
  expected?: Expected
): Segment {
  // A quick edit checks its pages after its preview exists and before its
  // review opens, so it is still at work until then.
  const checking = build.lane === "quick" && build.state === "preview_ready"
  const state = checking ? "now" : groupOf(build.state)
  const stage = build.activity?.find((r) => r.now)?.id
  const here = checking
    ? 2
    : state === "done"
      ? CHANGE_STEPS.length
      : stage !== undefined
        ? (CHANGE_OF_STAGE[stage] ?? 1)
        : (CHANGE_AT[build.state] ?? 1)
  return {
    id: `change:${build.assignment_id}`,
    kind: "change",
    state,
    steps: along(CHANGE_STEPS, here, state === "waiting" ? "waiting" : "now"),
    at:
      state === "done"
        ? (build.ready_at ?? build.updated_at)
        : build.created_at,
    ...(build.label && { names: { change: build.label } }),
    ...(checking && { step: "Checking the page" }),
    ...usualFor(state, build, expected),
  }
}

// ---------------------------------------------------------------------------
// Renewals

/** A bought domain's renewal, when its registration says when it lapses. */
function renewalOf(row: DomainRow): Segment | null {
  const expires = row.registration?.expires_at
  if (!expires) return null
  return {
    id: `renewal:${row.id}`,
    kind: "purchase",
    state: "upcoming",
    steps: [],
    at: iso(expires),
    names: { domain: row.name },
  }
}

// ---------------------------------------------------------------------------
// Owner tasks

/** A task step in the panel's terms. */
const STEP_STATE: Record<TaskStepState, Step["state"]> = {
  pending: "next",
  in_progress: "now",
  blocked: "waiting",
  done: "done",
  skipped: "skipped",
}

/**
 * An open or finished task as one segment, its steps the task's own: waiting
 * while a step waits on the owner, now while one is at work, coming up while
 * none has begun, done once the task is. A task put off or declined is no
 * segment. Google keeps the id its standing row has, so a finished one is
 * listed once.
 */
export function taskSegment(task: OwnerTask): Segment | null {
  if (task.state !== "active" && task.state !== "done") return null
  const blocked = task.steps.find((s) => s.state === "blocked")
  const state =
    task.state === "done"
      ? "done"
      : blocked
        ? "waiting"
        : task.steps.some((s) => s.state === "in_progress")
          ? "now"
          : "upcoming"
  const detail: AddressDetail = task.kind === "address" ? task.detail : {}
  const names = {
    ...(detail.name && { domain: detail.name }),
    ...(detail.provider && { provider: detail.provider }),
  }
  // The records step counts the changes the connect card listed.
  const changes = detail.changes
  return {
    id: task.kind === "google" ? "google" : `address:${task.id}`,
    kind: task.kind,
    state,
    steps: task.steps.map((s) => ({
      id: s.step,
      state: STEP_STATE[s.state],
      ...(s.state === "done" && s.changed_at && { at: s.changed_at }),
      ...(s.state === "blocked" && s.note && { note: s.note }),
      ...(s.step === "records" &&
        changes && {
          count: { done: s.state === "done" ? changes : 0, total: changes },
        }),
    })),
    at: iso((state === "done" && task.done_at) || task.created_at),
    ...(blocked?.deadline && { deadline: blocked.deadline }),
    ...(Object.keys(names).length > 0 && { names }),
  }
}

// ---------------------------------------------------------------------------
// The whole view

export type ActivityInput = {
  site: WorkspaceStatus["site"]
  /** The business name fact, the copy's `{business}`. */
  business: string | null
  builds: BuildSummary[]
  approvals: Approval[]
  questions: Question[]
  /** The workspace's last day of reports and alerts. */
  feed: Logged[]
  due: Due[]
  notes: Reminder[]
  rows: ActivityRows
  /** How long each lane usually takes, as the chat quotes it. */
  expected?: Expected
}

type Expected = WorkspaceStatus["expected_seconds"]

/** A build at work: its lane's usual and late times, the ones the chat quotes too, and whether it was restarted. */
const usualFor = (
  state: Segment["state"],
  build: BuildSummary,
  expected: Expected
) =>
  state === "now"
    ? {
        ...(expected && {
          usual_seconds: expected[build.lane ?? "full"].p50,
          late_seconds: expected[build.lane ?? "full"].p95,
        }),
        ...(build.restarted && { restarted: true as const }),
      }
    : {}

const recent = (at: string, now: Date) => now.getTime() - Date.parse(at) < DAY

/**
 * The first run's website and going-live segments until the site is first
 * live: the website (the newest build), then going live (its review and
 * publish). Onboarding, the first of the three, is `withOnboarding`'s: it
 * reads the chat, which nothing the CoS reaches may (ADR-034).
 */
export function journeyOf(input: ActivityInput): Segment[] {
  if (input.site.live) return []
  const names = input.business ? { business: input.business } : undefined
  const since = iso(input.rows.since)
  // A build the owner stopped leaves the website to come, as before one began.
  // A stopped change gives the draft back, so the build before it stands.
  const newest = input.builds.find(
    (b) => b.kind === "site.build" || b.state !== "cancelled"
  )
  const build = newest?.state === "cancelled" ? undefined : newest
  if (!build) {
    const failed = input.feed.find(
      (item) => item.kind === "alert" && item.reason === "build_failed"
    )
    return [
      {
        id: "website",
        kind: "website",
        state: failed ? "failed" : "upcoming",
        steps: along(STAGES, -1),
        at: failed ? failed.at : since,
        ...(names && { names }),
      },
      {
        id: "golive",
        kind: "golive",
        state: "upcoming",
        steps: along(GOLIVE_STEPS, -1),
        at: since,
        ...(names && { names }),
      },
    ]
  }
  const state = groupOf(build.state)
  const website: Segment = {
    id: "website",
    kind: "website",
    state,
    steps:
      state === "done" ? along(STAGES, STAGES.length) : websiteSteps(build),
    at:
      state === "done"
        ? (build.ready_at ?? build.updated_at)
        : build.created_at,
    ...(build.retry && state !== "done"
      ? { step: "Fixing what stopped the last build" }
      : {}),
    ...usualFor(state, build, input.expected),
    ...(names && { names }),
  }
  const review = input.approvals.find(
    (a) => a.request.assignment_id === build.assignment_id
  )
  const golive: Segment =
    build.state === "release_candidate"
      ? {
          id: "golive",
          kind: "golive",
          state: "now",
          steps: along(GOLIVE_STEPS, 1),
          at: build.updated_at,
        }
      : review
        ? {
            id: "golive",
            kind: "golive",
            state: "waiting",
            steps: along(GOLIVE_STEPS, 0, "waiting"),
            at: review.request.requested_at,
            deadline: review.request.expires_at,
          }
        : {
            id: "golive",
            kind: "golive",
            state: "upcoming",
            steps: along(GOLIVE_STEPS, -1),
            at: since,
          }
  // A change to the draft before it is first live: the website is built and
  // the change is the step under way, named as a change after publishing is.
  const made: Segment[] =
    build.kind === "site.revise"
      ? [
          {
            id: "website",
            kind: "website",
            state: "done",
            steps: along(STAGES, STAGES.length),
            at: build.created_at,
            ...(names && { names }),
          },
          changeSegment(build, input.expected),
        ]
      : [website]
  return [...made, { ...golive, ...(names && { names }) }]
}

/** The most rows Coming up lists of each kind. */
const NEXT_REMINDERS = 3

/** Segments soonest first by `at`, or latest first. */
const byAt = (latest: boolean) => (a: Segment, b: Segment) =>
  (Date.parse(a.at) - Date.parse(b.at)) * (latest ? -1 : 1)

/** The contract's bound on a group. */
const SEGMENTS_MAX = 20

const liveNames = (input: ActivityInput) => ({
  ...(input.business && { business: input.business }),
})

/**
 * Where the site stands whatever the age, for the Website page: the latest
 * publish, the address and Google tasks, and each bought domain's renewal.
 * The Google task carries when its data was last read and the 28 days of
 * searches, once Google has sent any.
 */
export function standingOf(input: ActivityInput): Segment[] {
  const { domains, live_at, search, tasks } = input.rows
  const standing: Segment[] = []
  if (input.site.live && live_at)
    standing.push({
      id: "published",
      kind: "golive",
      state: "done",
      steps: along(GOLIVE_STEPS, GOLIVE_STEPS.length),
      at: iso(live_at),
      names: liveNames(input),
    })
  for (const task of tasks) {
    const segment = taskSegment(task)
    if (!segment) continue
    // Google with no property (the domain it watched was removed) has nothing coming.
    if (
      segment.kind === "google" &&
      segment.state === "upcoming" &&
      search.properties === 0
    )
      continue
    standing.push(
      segment.kind === "google"
        ? {
            ...segment,
            ...(search.synced_at && { synced_at: iso(search.synced_at) }),
            ...(search.impressions > 0 && {
              numbers: {
                clicks: search.clicks,
                impressions: search.impressions,
              },
            }),
          }
        : segment
    )
  }
  standing.push(...domains.flatMap((row) => renewalOf(row) ?? []))
  return standing
}

/**
 * `Activity` from what the workspace read: the journey until the site is
 * first live, then each job in Now, Waiting on you, Coming up or Done
 * today. A journey build's review sits in its going-live segment, not in
 * Waiting on you.
 */
export function activityOf(input: ActivityInput, now: Date): Activity {
  const journey = journeyOf(input)
  const live = Boolean(input.site.live)
  const first = input.builds[0]?.assignment_id
  const segments: Segment[] = []

  if (live)
    segments.push(...input.builds.map((b) => changeSegment(b, input.expected)))
  // The address and Google work come from their tasks; renewals and the
  // Website page's standing rows still read the domain and Google rows.
  const tasks = input.rows.tasks.flatMap((t) => taskSegment(t) ?? [])
  segments.push(...tasks.filter((t) => t.state !== "upcoming"))

  for (const { request } of input.approvals) {
    if (!live && request.assignment_id === first) continue
    segments.push({
      id: `review:${request.approval_id}`,
      kind: "review",
      state: "waiting",
      steps: [],
      at: request.requested_at,
      deadline: request.expires_at,
    })
  }
  for (const { request } of input.questions)
    segments.push({
      id: `question:${request.request_id}`,
      kind: "question",
      state: "waiting",
      steps: [],
      at: request.requested_at,
      ...(request.expires_at && { deadline: request.expires_at }),
    })

  // Done today from the feed: the first publish is going live, a later one
  // a change, a failed build after the site is live a change that stopped.
  const firstLive = input.rows.first_live
  if (firstLive && recent(firstLive.at, now))
    segments.push({
      id: "golive",
      kind: "golive",
      state: "done",
      steps: along(GOLIVE_STEPS, GOLIVE_STEPS.length),
      at: iso(firstLive.at),
      names: liveNames(input),
    })
  for (const item of input.feed) {
    if (!item.assignment_id) continue
    const id = `change:${item.assignment_id}`
    if (segments.some((s) => s.id === id)) continue
    if (
      item.kind === "report" &&
      item.assignment_id !== firstLive?.assignment_id
    )
      segments.push({
        id,
        kind: "change",
        state: "done",
        steps: along(CHANGE_STEPS, CHANGE_STEPS.length),
        at: item.at,
      })
    if (live && item.kind === "alert" && item.reason === "build_failed")
      segments.push({
        id,
        kind: "change",
        state: "failed",
        steps: along(CHANGE_STEPS, -1),
        at: item.at,
      })
  }

  // Coming up: the next reminders at any distance, the next check-in, renewals.
  const upcoming: Segment[] = [
    ...input.notes
      .filter((n) => n.due_at && Date.parse(n.due_at) > now.getTime())
      .slice(0, NEXT_REMINDERS)
      .map(
        (n): Segment => ({
          id: `reminder:${n.id}`,
          kind: "reminder",
          state: "upcoming",
          steps: [],
          at: n.due_at as string,
        })
      ),
    ...input.rows.domains.flatMap((row) => renewalOf(row) ?? []),
    ...tasks.filter((t) => t.state === "upcoming"),
  ]
  const beat = input.rows.heartbeat
  if (beat?.next)
    upcoming.push({
      id: "checkin:next",
      kind: "checkin",
      state: "upcoming",
      steps: [],
      at: iso(beat.next),
    })

  // Done today also holds reminders that came due and the last check-in,
  // quiet or not; `message` says whether it wrote to the owner. A failed
  // run told the owner nothing, so it is not listed.
  const done: Segment[] = input.due
    .filter((d) => recent(d.due_at, now))
    .map((d) => ({
      id: `reminder:${d.reminder_id}`,
      kind: "reminder" as const,
      state: "done" as const,
      steps: [],
      at: d.due_at,
    }))
  if (beat?.last && beat.last.outcome !== "failed")
    done.push({
      id: "checkin:last",
      kind: "checkin",
      state: "done",
      steps: [
        {
          id: "message",
          state: beat.last.outcome === "ok" ? "done" : "skipped",
        },
      ],
      at: iso(beat.last.at),
    })

  for (const s of segments) {
    if (s.state === "now") continue
    if (s.state === "waiting") continue
    if (recent(s.at, now)) done.push(s)
  }
  const cap = (list: Segment[], latest = false) =>
    list.sort(byAt(latest)).slice(0, SEGMENTS_MAX)
  return {
    journey,
    now: cap(segments.filter((s) => s.state === "now")),
    waiting: cap(segments.filter((s) => s.state === "waiting")),
    upcoming: cap(upcoming),
    done: cap(done, true),
    standing: standingOf(input),
  }
}

/**
 * The journey with onboarding first, for the `/workspace` read, which alone
 * reads the onboarding conversation. Nothing to add once the site is live.
 */
export const withOnboarding = (
  activity: Activity,
  onboarding: Segment | null
): Activity =>
  onboarding && activity.journey.length > 0
    ? { ...activity, journey: [onboarding, ...activity.journey] }
    : activity
