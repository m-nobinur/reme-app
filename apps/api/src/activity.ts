import type {
  Activity,
  ActivitySegment,
  ActivityStep,
  AssignmentState,
  AttentionItem,
  BuildSummary,
  Reminder,
  WorkspaceStatus,
} from "@workspace/contracts"
import { type OrgScopedDb, sql } from "@workspace/db"
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

/** A domain row as `readActivityRows` selects it; times as the database wrote them. */
export type DomainRow = {
  id: string
  name: string
  origin: "connected" | "purchased"
  state: string
  /** The last `DomainCheck`'s status. */
  check: string | null
  /** A purchase's `DomainRegistration`, as stored. */
  registration: {
    status?: string
    outcome?: string
    expires_at?: string
  } | null
  /** The owner sent their details and a Checkout Session is stored. */
  checkout: boolean
  created_at: string
  activated_at: string | null
}

export type GoogleRow = {
  state: "active" | "needs_reauth" | "revoked"
  connected_at: string | null
  /** The newest property: the site Google is reading now. */
  property: {
    state: "pending" | "verified" | "failed" | "stale"
    verified_at: string | null
    sitemap_at: string | null
    synced_at: string | null
    created_at: string
  } | null
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
  google: GoogleRow | null
  heartbeat: HeartbeatRow | null
  /** The site's first publish, and the build it published. */
  first_live: { at: string; assignment_id: string | null } | null
  /** When the site last published, or null before the first time. */
  live_at: string | null
}

/** A day back from `now`, as SQL: the window "Done today" reads. */
const dayBefore = (now: Date) =>
  sql`${now.toISOString()}::timestamptz - interval '24 hours'`

/**
 * The rows only the activity view reads, in one statement from the org's
 * own row: its domains by `domains_org_state_idx`, the Google connection by
 * its key and its newest property by `search_properties_org_site_url`, the
 * heartbeat's newest run by `job_runs_pkey`, and the first publish by
 * `deployments_site_config_version_key`.
 *
 * shortcut: the heartbeat row is found by kind with no index on
 * `scheduled_jobs (org_id, kind)`, a scan of a small table; add the index
 * when the table grows past a few thousand rows.
 */
export async function readActivityRows(
  db: OrgScopedDb,
  now: Date
): Promise<ActivityRows> {
  const [row] = await db.execute<ActivityRows>(sql`
    select o.created_at as since,
      (select coalesce(json_agg(d), '[]'::json) from (
        select id, name, origin, state, last_check->>'status' as check,
          registration, stripe is not null as checkout, created_at, activated_at
        from domains where state <> 'removed'
        order by created_at desc limit 10) d) as domains,
      (select json_build_object('state', c.state, 'connected_at', c.connected_at,
        'property', (select json_build_object('state', p.state,
          'verified_at', p.verified_at, 'sitemap_at', p.sitemap->>'submitted_at',
          'synced_at', p.last_synced_at, 'created_at', p.created_at)
          from search_properties p order by p.created_at desc limit 1))
        from search_connections c) as google,
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
    from orgs o limit 1`)
  if (!row) throw new Error("the org's own row is not visible")
  return row
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
export const DOMAIN_STEPS = ["dns", "certificate", "loads"] as const
export const PURCHASE_STEPS = [
  "details",
  "payment",
  "registration",
  "connecting",
] as const
export const GOOGLE_STEPS = ["sign_in", "verify", "sitemap"] as const

/** Where a change stands, by the build stage it is on. */
const CHANGE_OF_STAGE: Record<string, number> = {
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
export function changeSegment(build: BuildSummary): Segment {
  const state = groupOf(build.state)
  const stage = build.activity?.find((r) => r.now)?.id
  const here =
    state === "done"
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
  }
}

// ---------------------------------------------------------------------------
// Domains and purchases

/** A connected domain: the owner's DNS change, the certificate, the site loading on it. */
export function domainSegment(row: DomainRow): Segment {
  const base = {
    id: `domain:${row.id}`,
    kind: "domain" as const,
    names: { domain: row.name },
  }
  if (row.state === "active")
    return {
      ...base,
      state: "done",
      steps: along(DOMAIN_STEPS, DOMAIN_STEPS.length),
      at: iso(row.activated_at ?? row.created_at),
    }
  // Valid at Cloudflare and still verifying: only the first load is left.
  const here = row.state === "verifying" ? (row.check === "valid" ? 2 : 1) : 0
  if (row.state === "failed")
    // shortcut: a failed row keeps no time of its own, so it reads as of
    // when it was made; read its `domain.*` event if that shows wrongly.
    return {
      ...base,
      state: "failed",
      steps: along(DOMAIN_STEPS, here),
      at: iso(row.created_at),
    }
  return {
    ...base,
    state: here === 0 ? "waiting" : "now",
    steps: along(DOMAIN_STEPS, here, here === 0 ? "waiting" : "now"),
    at: iso(row.created_at),
  }
}

/**
 * How long an unpaid purchase holds its name: the purchase Workflow's four
 * payment rounds of 35 minutes (`PAYMENT_ROUNDS`, `PAYMENT_WAIT` in
 * `apps/orchestrator/src/domain-buy.ts`), after which the row is abandoned.
 *
 * shortcut: the Checkout Session's own `expires_at` is not stored, and the
 * owner may open a fresh one until this; store it on the row if the panel
 * needs the session's 31 minutes instead of the name's hold.
 */
export const PURCHASE_HOLD_MS = 4 * 35 * 60_000

/** A bought domain: details, payment, registration, then connecting it. */
export function purchaseSegment(row: DomainRow): Segment {
  const base = {
    id: `purchase:${row.id}`,
    kind: "purchase" as const,
    names: { domain: row.name },
  }
  const created = Date.parse(row.created_at)
  const deadline = new Date(created + PURCHASE_HOLD_MS).toISOString()
  if (row.state === "awaiting_payment") {
    const here = row.checkout ? 1 : 0
    return {
      ...base,
      state: "waiting",
      steps: along(PURCHASE_STEPS, here, "waiting"),
      at: iso(row.created_at),
      deadline,
    }
  }
  if (row.state === "abandoned")
    // The Checkout ran out unpaid: "Payment form expired".
    return {
      ...base,
      state: "failed",
      steps: along(PURCHASE_STEPS, row.checkout ? 1 : 0),
      at: deadline,
      deadline,
    }
  if (row.state === "failed")
    // Paid, then the registration was refused or the hold released.
    // shortcut: no close time is kept, so it reads as of when it was made.
    return {
      ...base,
      state: "failed",
      steps: along(PURCHASE_STEPS, 2),
      at: iso(row.created_at),
    }
  if (row.state === "active")
    return {
      ...base,
      state: "done",
      steps: along(PURCHASE_STEPS, PURCHASE_STEPS.length),
      at: iso(row.activated_at ?? row.created_at),
    }
  // Paid: registering until Cloudflare says registered, then connecting.
  const registered =
    row.registration?.status === "registered" ||
    row.registration?.outcome === "registered" ||
    row.registration?.outcome === "test_registered"
  return {
    ...base,
    state: "now",
    steps: along(PURCHASE_STEPS, registered ? 3 : 2),
    at: iso(row.created_at),
  }
}

/** A bought domain's renewal, when its registration says when it lapses. */
function renewalOf(row: DomainRow): Segment | null {
  const expires = row.registration?.expires_at
  if (row.origin !== "purchased" || row.state !== "active" || !expires)
    return null
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
// Google

/**
 * The Search Console connection: signed in, the site verified, the sitemap
 * sent. No segment before the owner connects or after they ended it.
 *
 * shortcut: the consent screen's state lives in a cookie, so an owner who
 * has the link but has not signed in yet has no row and no segment; a
 * `needs_reauth` connection waits on sign in with no deadline.
 */
export function googleSegment(row: GoogleRow | null): Segment | null {
  if (!row || row.state === "revoked") return null
  const at = row.connected_at ?? row.property?.created_at
  if (!at) return null
  const base = { id: "google", kind: "google" as const }
  if (row.state === "needs_reauth")
    return {
      ...base,
      state: "waiting",
      steps: along(GOOGLE_STEPS, 0, "waiting"),
      at: iso(at),
    }
  const p = row.property
  const verified = p?.state === "verified" || p?.state === "stale"
  const here = !verified ? 1 : p?.sitemap_at ? 3 : 2
  if (p?.state === "failed")
    return {
      ...base,
      state: "failed",
      steps: along(GOOGLE_STEPS, 1),
      at: iso(p.created_at),
    }
  const finished = [row.connected_at, p?.verified_at, p?.sitemap_at]
    .filter((t): t is string => Boolean(t))
    .map(Date.parse)
  return {
    ...base,
    state: here === 3 ? "done" : "now",
    steps: along(GOOGLE_STEPS, here),
    at: here === 3 ? new Date(Math.max(...finished)).toISOString() : iso(at),
    ...(p?.synced_at && { synced_at: iso(p.synced_at) }),
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
}

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
  const build = input.builds[0]
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
  return [website, { ...golive, ...(names && { names }) }]
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
  ...(input.site.host && { host: input.site.host }),
})

/**
 * Where the site stands whatever the age, for the Website page: the latest
 * publish, each domain with its renewal, and the Google connection. An
 * unpaid purchase that ran out is not a standing state, so it is left out.
 */
export function standingOf(input: ActivityInput): Segment[] {
  const { domains, google, live_at } = input.rows
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
  for (const row of domains) {
    if (row.state === "abandoned") continue
    standing.push(
      row.origin === "purchased" ? purchaseSegment(row) : domainSegment(row)
    )
    const renewal = renewalOf(row)
    if (renewal) standing.push(renewal)
  }
  const segment = googleSegment(google)
  if (segment) standing.push(segment)
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

  if (live) segments.push(...input.builds.map(changeSegment))
  for (const row of input.rows.domains)
    segments.push(
      row.origin === "purchased" ? purchaseSegment(row) : domainSegment(row)
    )
  const google = googleSegment(input.rows.google)
  if (google) segments.push(google)

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
