import {
  ActivityFeed,
  ApprovalRequest,
  type AssignmentState,
  type AttentionItem,
  Blueprint,
  type BuildActivity,
  type BuildLane,
  type BuildPhoto,
  type BuildStopCause,
  type BuildSummary,
  type DerivedReminder,
  type FactRecord,
  FactValue,
  FactValueKey,
  InformationRequest,
  PLANNED_PAGES,
  SiteFields,
  siteHost,
  siteUrl,
  TERMINAL_STATES,
  thumbnailOf,
  WorkspaceStatus,
} from "@workspace/contracts"
import {
  approvals,
  assignments,
  currentFacts,
  eq,
  events,
  type OrgScopedDb,
  orgs,
  siteRevisions,
  sql,
  type Tenancy,
  toFactRecord,
  waitedOn,
} from "@workspace/db"
import { factsToAsk } from "@workspace/gates/fields"
import { fields } from "@workspace/starter-site/site-config"
import { sha256Hex } from "./http.ts"
import { readReminderNotes } from "./reminders.ts"

/**
 * What the owner's panel polls: attention derived from `assignments`,
 * `approvals` and `events` on every read, never stored. Every read here runs
 * inside the caller's `withOrg`, so the policy is the org filter, and each
 * one rides an index: the org's assignments, `approvals_one_open_per_revision`
 * for open approvals, `assignment_transitions_version_key` for a build's
 * latest block, the events primary key for the event that block logged,
 * `events_assignment_type_idx` for questions, answers and the feed,
 * `facts_one_current_per_key` for facts, and
 * `deployments_site_config_version_key` for the live revision.
 */

/** Parsed once per isolate, so a config the contract refuses fails at load. */
const FIELDS = SiteFields.parse(fields)

type RevisionRef = { revision_id: string; version: number }
type Report = Extract<AttentionItem, { kind: "report" }>
type Alert = Extract<AttentionItem, { kind: "alert" }>

const iso = (at: Date) => at.toISOString()

/**
 * shortcut: constants until EV3's rolling p50 and p95 per lane exist; swap
 * this one object for the measured numbers, nothing else reads them.
 */
export const EXPECTED_SECONDS = {
  quick: { p50: 15, p95: 45 },
  full: { p50: 180, p95: 330 },
} as const

/** The steps in the order a full build reaches them; the photos row travels with the pages. */
const ORDER = ["planning", "writing", "design", "fixing", "checking"] as const
type Step = (typeof ORDER)[number]

/**
 * An event that says where a build has got to, in the order they landed: the
 * lead's completion report, the design look's rounds (`fixes` is how many it
 * asked for, none when it did not run) and each move into `repairing`, which
 * `readBuilds` is the only one to select. The assignment state alone cannot
 * say these: the look and the lead's fix rounds both happen in `implementing`,
 * and a gate repair returns to `implementing` in the same instant.
 */
export type Mark = { type: string; fixes?: number | null }

const REPORTED = "assignment.completion_reported"
const REPAIRED = "assignment.state_changed"

/**
 * The step a build is on, or null in a state that is not one of them. After
 * the lead's first report a planned build is being looked over until a look
 * asks for nothing or the second has run; a move into `repairing` that no
 * report has followed is the lead fixing what the gates found.
 */
function stepOf(
  state: AssignmentState,
  marks: readonly Mark[],
  planned: boolean
): Step | null {
  if (state === "planning") return "planning"
  if (state === "validating") return "checking"
  if (state === "repairing") return "fixing"
  if (!["implementing", "revising"].includes(state)) return null
  const types = marks.map((m) => m.type)
  const reported = types.lastIndexOf(REPORTED)
  if (types.lastIndexOf(REPAIRED) > reported) return "fixing"
  if (reported < 0) return "writing"
  const asked = marks.find((m) => m.type === "design.critiqued")
  const looked =
    marks.some((m) => m.type === "design.rechecked") ||
    (asked !== undefined && !asked.fixes)
  return planned && !looked ? "design" : "checking"
}

/** Counts from the parallel builder's `build.progress` events (BA4), by stage. */
export type Progress = Partial<
  Record<"pages" | "photos", { done: number; total: number }>
>

/** One `build.progress` row that finished something: a page, or a photo slot with how it settled. */
export type Settled = {
  stage: string
  item: string
  status?: string | null
  asset_id?: string | null
}

/** The most a row counts to (the contract's bound). */
const COUNT_MAX = 999

/** The generated slots a plan still has to draw. */
const toDraw = (plan: Blueprint | null | undefined) =>
  (plan?.images ?? []).filter((i) => i.source === "generated" && !i.asset_id)

/**
 * Every step of the build, in order: those passed are done, the rest count
 * what they have finished so far. A planned build counts its photos, when it
 * makes any, and names its pages ("Writing the pages, 3 of 5"), then has its
 * design looked over before the checks. A build the gates sent back shows
 * "Fixing what the checks found" until the lead reports again. The step it is
 * on follows the build's own events (`marks`), not the state alone; the pages
 * tick as each is written, or all at once when the lead reports a build it
 * wrote itself. Any other step is whole, `1 of 1`. A quick build gets none;
 * the panel shows one line for it.
 */
export function activityFor(
  lane: BuildLane,
  state: AssignmentState,
  progress: Progress = {},
  {
    plan,
    settled = [],
    marks = [],
  }: { plan?: Blueprint | null; settled?: Settled[]; marks?: Mark[] } = {}
): BuildActivity[] {
  const at = stepOf(state, marks, Boolean(plan))
  if (lane === "quick" || !at) return []
  const now = ORDER.indexOf(at)
  const passed = (step: Step) => ORDER.indexOf(step) < now
  const row = (
    id: string,
    label: string,
    done: boolean,
    count?: { done: number; total: number }
  ): BuildActivity => {
    const total = Math.min(Math.max(count?.total ?? 1, 1), COUNT_MAX)
    return {
      id,
      label,
      done: done ? total : Math.min(count?.done ?? 0, total),
      total,
      ...(id === at ? { now: true as const } : {}),
    }
  }
  const pagesDone = new Set(
    settled.filter((s) => s.stage === "pages").map((s) => s.item)
  )
  const pages = plan?.pages.map(({ page }) => ({
    label: PLANNED_PAGES.find((p) => p.id === page)?.label ?? page,
    done: passed("writing") || pagesDone.has(page),
  }))
  const photos =
    progress.photos ??
    (toDraw(plan).length > 0
      ? { done: 0, total: toDraw(plan).length }
      : undefined)
  const repaired = marks.some((m) => m.type === REPAIRED)
  return [
    row("planning", "Planning the layout", passed("planning")),
    ...(photos
      ? [row("photos", "Making photos", passed("writing"), photos)]
      : []),
    {
      ...row("writing", "Writing the pages", passed("writing"), progress.pages),
      ...(pages ? { items: pages } : {}),
    },
    // BA5's look before the gates runs only on a planned build.
    ...(plan
      ? [row("design", "Looking over the design", passed("design"))]
      : []),
    ...(repaired || at === "fixing"
      ? [row("fixing", "Fixing what the checks found", passed("fixing"))]
      : []),
    row("checking", "Checking the site", passed("checking")),
  ]
}

/**
 * The photos a build is making, once its photo step has started: the slots
 * that settled, in the order they did, then those still drawing. A slot that
 * fell back has left the plan, so it has no alt.
 */
export function photosOf(
  plan: Blueprint | null | undefined,
  settled: Settled[]
): BuildPhoto[] {
  const alt = new Map((plan?.images ?? []).map((i) => [i.id, i.alt]))
  const done = new Map<string, BuildPhoto>()
  for (const s of settled) {
    if (s.stage !== "photos" || done.has(s.item)) continue
    const fell = s.status === "fallback"
    done.set(s.item, {
      slot_id: s.item,
      state: fell ? "fallback" : "made",
      alt: alt.get(s.item) ?? null,
      thumbnail: fell ? null : thumbnailOf(s.asset_id),
    })
  }
  const drawing = toDraw(plan)
    .filter((i) => !done.has(i.id))
    .map(
      (i): BuildPhoto => ({
        slot_id: i.id,
        state: "drawing",
        alt: i.alt,
        thumbnail: null,
      })
    )
  return [...done.values(), ...drawing].slice(0, 24)
}

/**
 * Site builds that have not finished, newest first, each with its latest
 * numbered revision: none until a report passes the gates, since a refused
 * one never takes a version. The panel caps the list; routing a change reads
 * all of them.
 */
export async function readBuilds(
  db: OrgScopedDb,
  limit: number | null = 10
): Promise<BuildSummary[]> {
  const query = db
    .select({
      id: assignments.id,
      kind: assignments.kind,
      state: assignments.state,
      goal: assignments.goal,
      createdAt: assignments.createdAt,
      updatedAt: assignments.updatedAt,
      // QE3 records the lane on the creation event; no row has it as a column.
      lane: sql<
        string | null
      >`(select e.payload->>'lane' from events e where e.assignment_id = assignments.id and e.type = 'assignment.created' limit 1)`,
      // QE4: the quick lane handed the change on, to the Developer or on to
      // the build model. The orchestrator logs each, and the row's lane is
      // only where it started.
      fell: sql<boolean>`exists (select 1 from events e where e.assignment_id = assignments.id and (e.type = 'quick.fell_through' or (e.type = 'model.switched' and e.payload->>'reason' = 'quick.fell_through')))`,
      // Written out rather than interpolated: in a one-table select drizzle
      // drops the table name, and a bare `id` here would mean the revision's.
      revision: sql<RevisionRef | null>`(select json_build_object('revision_id', r.id, 'version', r.version) from site_revisions r where r.assignment_id = assignments.id and r.version is not null order by r.version desc limit 1)`,
      // ADR-038: the plan on the row, the round it is and the plan it
      // changed from the newest `blueprint.proposed`, and the newest round
      // the owner decided on, all by `events_assignment_type_idx`.
      blueprint: assignments.blueprint,
      proposed: sql<Record<
        string,
        unknown
      > | null>`(select e.payload from events e where e.assignment_id = assignments.id and e.type = 'blueprint.proposed' order by e.event_id desc limit 1)`,
      decidedRound: sql<
        number | null
      >`(select max((e.payload->>'round')::int) from events e where e.assignment_id = assignments.id and e.type = 'blueprint.decided')`,
      // BA4's counts: distinct pages or photos finished per stage, and the
      // stage's total, so a repeated event never counts twice.
      progress: sql<Progress | null>`(select json_object_agg(p.stage, json_build_object('done', p.done, 'total', p.total)) from (select e.payload->>'stage' as stage, count(distinct e.payload->>'item')::int as done, max((e.payload->>'total')::int) as total from events e where e.assignment_id = assignments.id and e.type = 'build.progress' group by 1) p)`,
      // The same rows by name, in the order they landed: which pages are
      // written, and how each photo slot settled.
      settled: sql<
        Settled[] | null
      >`(select json_agg(json_build_object('stage', e.payload->>'stage', 'item', e.payload->>'item', 'status', e.payload->>'status', 'asset_id', e.payload->>'asset_id') order by e.event_id) from events e where e.assignment_id = assignments.id and e.type = 'build.progress' and e.payload->>'item' is not null)`,
      // Where the build has got to, in order: the lead's reports, the design
      // look's rounds and each move into repairing (`activityFor`'s marks).
      marks: sql<
        Mark[] | null
      >`(select json_agg(json_build_object('type', e.type, 'fixes', case when jsonb_typeof(e.payload->'fixes') = 'array' then jsonb_array_length(e.payload->'fixes') end) order by e.event_id) from events e where e.assignment_id = assignments.id and (e.type in ('assignment.completion_reported', 'design.critiqued', 'design.rechecked') or (e.type = 'assignment.state_changed' and e.payload->>'to' = 'repairing')))`,
      // Time the build waited on the owner's decided plan reviews: each
      // `blueprint.decided` back to the review round it answered.
      reviewMs: sql<
        number | null
      >`(select sum(extract(epoch from (d.occurred_at - p.occurred_at)) * 1000)::float8 from events d join events p on p.assignment_id = d.assignment_id and p.type = 'blueprint.proposed' and p.payload->>'review' = 'true' and p.payload->>'round' = d.payload->>'round' where d.assignment_id = assignments.id and d.type = 'blueprint.decided')`,
    })
    .from(assignments)
    .where(
      sql`${assignments.kind} in ('site.build', 'site.revise') and ${assignments.state} not in ${TERMINAL_STATES}`
    )
    .orderBy(sql`${assignments.createdAt} desc`)
  const rows = await (limit === null ? query : query.limit(limit))
  return rows.map((row) => {
    const fellThrough = row.fell && row.lane === "quick"
    const lane: BuildLane =
      row.lane === "quick" && !fellThrough ? "quick" : "full"
    const plan = Blueprint.safeParse(row.blueprint).data ?? null
    const settled = row.settled ?? []
    const progress = row.progress ?? {}
    return {
      assignment_id: row.id,
      kind: row.kind as BuildSummary["kind"],
      state: row.state,
      goal: row.goal,
      lane,
      ...(fellThrough ? { fell_through: true } : {}),
      activity: activityFor(lane, row.state, progress, {
        plan,
        settled,
        marks: row.marks ?? [],
      }),
      revision: row.revision,
      ...planOf(row),
      ...(progress.photos ? { photos: photosOf(plan, settled) } : {}),
      ...(row.reviewMs ? { review_ms: Math.round(row.reviewMs) } : {}),
      created_at: iso(row.createdAt),
      updated_at: iso(row.updatedAt),
    }
  })
}

/**
 * The build's Blueprint for the card, when it planned one that still parses.
 * It waits on the owner while the build is planning, its round asked for a
 * review, and no decision on that round is stored.
 */
export function planOf(row: {
  state: AssignmentState
  blueprint: unknown
  proposed: Record<string, unknown> | null
  decidedRound: number | null
}): Pick<BuildSummary, "blueprint"> {
  const plan = Blueprint.safeParse(row.blueprint)
  const round = Number(row.proposed?.round)
  if (!plan.success || !Number.isInteger(round) || round < 1) return {}
  return {
    blueprint: {
      plan: plan.data,
      round,
      previous: Blueprint.safeParse(row.proposed?.previous).data ?? null,
      awaiting:
        row.state === "planning" &&
        row.proposed?.review === true &&
        row.decidedRound !== round,
    },
  }
}

/** The lane one assignment was created in; `full` when none was recorded. */
export async function readLane(
  db: OrgScopedDb,
  assignmentId: string
): Promise<BuildLane> {
  const rows = await db.execute(
    sql`select payload->>'lane' as lane from events where assignment_id = ${assignmentId} and type = 'assignment.created' limit 1`
  )
  return (rows[0]?.lane as string | undefined) === "quick" ? "quick" : "full"
}

/**
 * Revision approvals the orchestrator would take a decision on now, soonest
 * expiry first: undecided, on a build awaiting review and in date, or on a
 * build the sweep parked, where a late decision still counts (ADR-032). One
 * that expired before the hourly sweep parked it is left out, since until
 * then the orchestrator refuses it.
 */
export async function readApprovals(
  db: OrgScopedDb
): Promise<Extract<AttentionItem, { kind: "approval" }>[]> {
  const rows = await db
    // A review opens only on a revision that passed the gates, which is
    // numbered by then; the filter says so to the type.
    .select({ row: approvals, version: sql<number>`${siteRevisions.version}` })
    .from(approvals)
    .innerJoin(siteRevisions, eq(siteRevisions.id, approvals.revisionId))
    .innerJoin(assignments, eq(assignments.id, approvals.assignmentId))
    .where(
      sql`${approvals.decision} is null and ${siteRevisions.version} is not null and ((${assignments.state} = 'awaiting_review' and ${approvals.expiresAt} > now()) or ${assignments.state} = 'blocked_on_approval')`
    )
    .orderBy(approvals.expiresAt)
  // The generated photos each build placed, from its newest `site.photos` event.
  const ids = rows.flatMap(({ row }) =>
    row.assignmentId ? [row.assignmentId] : []
  )
  const placed = new Map<string, NonNullable<ApprovalPhotos>>()
  if (ids.length > 0) {
    const found = await db.execute(
      sql`select distinct on (assignment_id) assignment_id, payload->'slots' as slots from events where type = 'site.photos' and assignment_id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `
      )}) order by assignment_id, event_id desc`
    )
    for (const r of found as unknown as {
      assignment_id: string
      slots: {
        id: string
        section: string
        alt: string
        source: string
        asset_id?: string
      }[]
    }[]) {
      const photos = r.slots
        .filter((s) => s.source === "generated")
        .map((s) => {
          const thumbnail = thumbnailOf(s.asset_id)
          return {
            slot_id: s.id,
            section: s.section,
            alt: s.alt,
            ...(thumbnail ? { thumbnail } : {}),
          }
        })
      if (photos.length > 0) placed.set(r.assignment_id, photos)
    }
  }
  return rows.map(({ row, version }) => ({
    kind: "approval",
    request: ApprovalRequest.parse({
      approval_id: row.id,
      org_id: row.orgId,
      assignment_id: row.assignmentId,
      requested_by_staff_id: row.requestedByStaffId,
      approver_staff_id: row.approverStaffId,
      action_kind: row.actionKind,
      target: row.target,
      rationale: row.rationale,
      requested_at: iso(row.requestedAt),
      expires_at: iso(row.expiresAt),
    }),
    version,
    ...(row.assignmentId && placed.has(row.assignmentId)
      ? { photos: placed.get(row.assignmentId) }
      : {}),
  }))
}

type ApprovalPhotos = Extract<AttentionItem, { kind: "approval" }>["photos"]

/**
 * The question each waiting build is blocked on (`waitedOn`), open ones only,
 * oldest first, in one query. An answered question is not shown while the
 * Workflow wakes. The orchestrator's `/answer` reads the same helper and
 * refuses any other.
 */
export async function readQuestions(
  db: OrgScopedDb
): Promise<Extract<AttentionItem, { kind: "question" }>[]> {
  const waiting = await waitedOn(db, undefined, { unanswered: true })
  return waiting.map((waited) => ({
    kind: "question" as const,
    request: InformationRequest.parse(waited.request),
  }))
}

/**
 * Reports and alerts from the last `hours`, newest first: a publish, a
 * failed build, a build parked on its budget, a publish the probes rolled
 * back. Reached through the org's recently touched assignments, so the
 * event index is probed per build rather than the org's whole log scanned.
 */
async function readFeed(
  db: OrgScopedDb,
  hours: number,
  limit: number
): Promise<(Report | Alert)[]> {
  const rows = await db
    .select({
      eventId: events.eventId,
      assignmentId: events.assignmentId,
      type: events.type,
      at: events.occurredAt,
      version: siteRevisions.version,
      revisionId: siteRevisions.id,
      // A failed build's reason, from its transition row by
      // `assignment_transitions_version_key`.
      failure: sql<
        string | null
      >`(select t.reason from assignment_transitions t where ${events.type} = 'assignment.state_changed' and t.assignment_id = ${events.assignmentId} and t.version = (${events.payload}->>'version')::int)`,
    })
    .from(assignments)
    .innerJoin(
      events,
      sql`${events.assignmentId} = ${assignments.id} and ${events.type} in ('deployment.activated', 'alert.raised', 'budget.exhausted', 'assignment.state_changed')`
    )
    .leftJoin(
      siteRevisions,
      sql`${siteRevisions.id} = case when ${events.type} = 'deployment.activated' then (${events.payload}->>'revision_id')::uuid end`
    )
    .where(
      sql`${assignments.updatedAt} > now() - make_interval(hours => ${hours}) and ${events.occurredAt} > now() - make_interval(hours => ${hours}) and (
        (${events.type} = 'deployment.activated' and ${events.payload}->>'kind' = 'publish')
        or (${events.type} = 'alert.raised' and ${events.payload}->>'kind' = 'publish.rolled_back')
        or ${events.type} = 'budget.exhausted'
        or (${events.type} = 'assignment.state_changed' and ${events.payload}->>'to' = 'failed'))`
    )
    .orderBy(sql`${events.eventId} desc`)
    .limit(limit)
  return rows.flatMap((row): (Report | Alert)[] => {
    const logged = {
      event_id: row.eventId,
      assignment_id: row.assignmentId,
      at: iso(row.at),
    }
    if (row.type === "deployment.activated") {
      return row.revisionId && row.version
        ? [
            {
              kind: "report",
              ...logged,
              what: "published",
              revision: { revision_id: row.revisionId, version: row.version },
            },
          ]
        : []
    }
    const reason =
      row.type === "alert.raised"
        ? "publish_rolled_back"
        : row.type === "budget.exhausted"
          ? "budget_parked"
          : "build_failed"
    return [
      {
        kind: "alert",
        ...logged,
        reason,
        ...(reason === "build_failed" ? { cause: causeOf(row.failure) } : {}),
      },
    ]
  })
}

/** The orchestrator's failure reasons, by the cause the owner is told. */
const CAUSES: Record<string, BuildStopCause> = {
  "developer.stalled": "stalled",
  "developer.timed_out": "stalled",
  "developer.no_report": "unfinished",
  "tool.repeating_failure": "unfinished",
  "gates.failed": "unfinished",
  "gates.repair_budget_exhausted": "unfinished",
  "information.unanswered": "unanswered",
  "blueprint.undecided": "unanswered",
  "provider.unavailable": "service",
  "sandbox.updating": "service",
  "sandbox.site_lost": "service",
}

/** Why a build failed, in the owner's terms; `other` for a reason with no words of its own. */
export const causeOf = (reason: string | null): BuildStopCause =>
  (reason && CAUSES[reason]) || "other"

/** The org's current facts, one per key. */
export async function readFacts(db: OrgScopedDb): Promise<FactRecord[]> {
  return (await currentFacts(db)).map(toFactRecord)
}

/** Where an environment's site links point: its host suffix and, on local dev, the router's port. */
export type SiteConfig = Pick<Env, "SITE_HOST_SUFFIX" | "SITE_PORT">

/** The revision the site serves now, and its host and link while it serves one. */
export async function readSite(
  db: OrgScopedDb,
  config: SiteConfig
): Promise<WorkspaceStatus["site"]> {
  const [row] = await db
    .select({
      slug: orgs.slug,
      // One site per org, and its id is the org's (ADR-031).
      live: sql<
        WorkspaceStatus["site"]["live"]
      >`(select json_build_object('revision_id', r.id, 'version', r.version, 'assignment_id', r.assignment_id) from deployments d join site_revisions r on r.id = d.revision_id where d.site_id = orgs.id order by d.config_version desc limit 1)`,
    })
    .from(orgs)
    .limit(1)
  const live = row?.live ?? null
  const host = row && live ? siteHost(row.slug, config.SITE_HOST_SUFFIX) : null
  return { host, url: host && siteUrl(host, config.SITE_PORT), live }
}

/** Required facts the org does not hold yet, minus the ones it keeps off the site. */
export function missingFacts(current: FactRecord[]): FactValueKey[] {
  const held = new Set(current.map((fact) => fact.key))
  return factsToAsk(FIELDS, current).ask.filter(
    (key): key is FactValueKey =>
      !held.has(key) && FactValueKey.safeParse(key).success
  )
}

/** The name the owner gave their assistant, when the fact still parses. */
export function assistantName(current: FactRecord[]): string | null {
  const held = current.find((fact) => fact.key === "assistant.name")
  const parsed =
    held && FactValue.safeParse({ key: held.key, value: held.value })
  return parsed?.success && parsed.data.key === "assistant.name"
    ? parsed.data.value.name
    : null
}

/** §7.3's order: approvals, questions, then alerts and reports, each list as read. */
export function orderAttention(
  approvalItems: AttentionItem[],
  questions: AttentionItem[],
  feed: (Report | Alert)[]
): AttentionItem[] {
  return [
    ...approvalItems,
    ...questions,
    ...feed.filter((item) => item.kind === "alert"),
    ...feed.filter((item) => item.kind === "report"),
  ]
}

const HOUR = 3_600_000

export type ReminderInput = {
  approvals: Extract<AttentionItem, { kind: "approval" }>[]
  questions: Extract<AttentionItem, { kind: "question" }>[]
  builds: BuildSummary[]
  missing: FactValueKey[]
}

/**
 * Reminders derived from what the panel already read, so each one clears
 * when its row resolves. Order: approvals soonest to expire first, then
 * questions longest open first, then previews newest build first, then the
 * missing facts, which have no deadline.
 *
 * A preview never published is a build that has sat in `preview_ready` for
 * over 12 hours: its gates passed and the preview exists, but no review was
 * opened on it. An owner build passes through `preview_ready` for seconds on
 * its way to review, so the wait keeps the rule to builds that stopped
 * there. Opening a review moves the build to `awaiting_review` and lists its
 * approval, which this rule then leaves to `approval_expiring`; the `listed`
 * check covers a review opened between the builds and approvals reads.
 * Publishing, a cancel or a newer build superseding it takes the build out
 * of `preview_ready`.
 */
export function deriveReminders(
  input: ReminderInput,
  now: Date
): DerivedReminder[] {
  const at = now.getTime()
  const listed = new Set(
    input.approvals.map((item) => item.request.assignment_id)
  )
  return [
    ...input.approvals.flatMap(({ request, version }): DerivedReminder[] => {
      const left = Date.parse(request.expires_at) - at
      return left > 0 && left < 24 * HOUR
        ? [
            {
              rule: "approval_expiring",
              approval_id: request.approval_id,
              version,
              expires_at: request.expires_at,
            },
          ]
        : []
    }),
    ...input.questions.flatMap(({ request }): DerivedReminder[] =>
      at - Date.parse(request.requested_at) > 12 * HOUR
        ? [{ rule: "question_waiting", request_id: request.request_id }]
        : []
    ),
    ...input.builds.flatMap((build): DerivedReminder[] =>
      build.state === "preview_ready" &&
      at - Date.parse(build.updated_at) > 12 * HOUR &&
      build.revision &&
      !listed.has(build.assignment_id)
        ? [
            {
              rule: "preview_unpublished",
              assignment_id: build.assignment_id,
              version: build.revision.version,
            },
          ]
        : []
    ),
    ...(input.missing.length > 0
      ? [{ rule: "facts_missing" as const, keys: input.missing }]
      : []),
  ]
}

/** Reports and alerts stay in the panel for a day; `/activity` keeps 30. */
const PANEL_HOURS = 24

export async function readWorkspace(
  kit: Tenancy,
  orgId: string,
  config: SiteConfig,
  now = new Date()
): Promise<WorkspaceStatus> {
  return kit.withOrg({ orgId }, async (db) => {
    // Issued together, so postgres.js pipelines them on the transaction's one
    // connection instead of paying a round trip each.
    const [builds, approvalItems, questions, feed, current, site, notes] =
      await Promise.all([
        readBuilds(db),
        readApprovals(db),
        readQuestions(db),
        readFeed(db, PANEL_HOURS, 10),
        readFacts(db),
        readSite(db, config),
        readReminderNotes(db),
      ])
    const missing = missingFacts(current)
    return WorkspaceStatus.parse({
      site,
      builds,
      expected_seconds: EXPECTED_SECONDS,
      attention: orderAttention(approvalItems, questions, feed),
      missing_facts: missing,
      assistant_name: assistantName(current),
      reminders: {
        notes,
        derived: deriveReminders(
          { approvals: approvalItems, questions, builds, missing },
          now
        ),
      },
    })
  })
}

export async function readActivity(
  kit: Tenancy,
  orgId: string
): Promise<ActivityFeed> {
  const items = await kit.withOrg({ orgId }, (db) => readFeed(db, 30 * 24, 50))
  return ActivityFeed.parse({ items })
}

/**
 * A strong validator over the body itself. The body carries no clock, so an
 * unchanged workspace hashes the same on every poll, and anything that
 * changes what the owner would see changes the tag.
 */
export async function etag(body: string): Promise<string> {
  return `"${(await sha256Hex(body)).slice(0, 32)}"`
}

/** Whether an `If-None-Match` header names this tag, weak or strong. */
export function unchanged(header: string | null, tag: string): boolean {
  if (!header) return false
  return header
    .split(",")
    .some((each) => each.trim().replace(/^W\//, "") === tag)
}
