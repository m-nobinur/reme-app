import {
  ActivityFeed,
  ApprovalRequest,
  type AssignmentState,
  type AttentionItem,
  Blueprint,
  type BuildActivity,
  type BuildLane,
  type BuildSummary,
  type DerivedReminder,
  type FactRecord,
  FactValue,
  FactValueKey,
  InformationRequest,
  SiteFields,
  siteHost,
  TERMINAL_STATES,
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

/** Stage rows in the order a full build reaches them; fixed strings, never model text. */
const STAGES: { id: string; label: string; at: AssignmentState[] }[] = [
  { id: "planning", label: "Planning the layout", at: ["planning"] },
  {
    id: "writing",
    label: "Writing the pages",
    at: ["implementing", "revising", "repairing"],
  },
  { id: "checking", label: "Checking the site", at: ["validating"] },
]

/**
 * Rows up to the build's current stage, earlier ones done. Whole-stage
 * `1 of 1` for now: "3 of 5" pages and photos need per-page events from the
 * parallel builder (BA4), which do not exist yet. A quick build gets none;
 * the panel shows one line for it.
 */
export function activityFor(
  lane: BuildLane,
  state: AssignmentState
): BuildActivity[] {
  const now = STAGES.findIndex((stage) => stage.at.includes(state))
  if (lane === "quick" || now < 0) return []
  return STAGES.slice(0, now + 1).map(({ id, label }, i) => ({
    id,
    label,
    done: i < now ? 1 : 0,
    total: 1,
  }))
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
    })
    .from(assignments)
    .where(
      sql`${assignments.kind} in ('site.build', 'site.revise') and ${assignments.state} not in ${TERMINAL_STATES}`
    )
    .orderBy(sql`${assignments.createdAt} desc`)
  const rows = await (limit === null ? query : query.limit(limit))
  return rows.map((row) => {
    const lane: BuildLane = row.lane === "quick" ? "quick" : "full"
    return {
      assignment_id: row.id,
      kind: row.kind as BuildSummary["kind"],
      state: row.state,
      goal: row.goal,
      lane,
      activity: activityFor(lane, row.state),
      revision: row.revision,
      ...planOf(row),
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
      slots: { id: string; section: string; alt: string; source: string }[]
    }[]) {
      const photos = r.slots
        .filter((s) => s.source === "generated")
        .map((s) => ({ slot_id: s.id, section: s.section, alt: s.alt }))
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
    return [{ kind: "alert", ...logged, reason }]
  })
}

/** The org's current facts, one per key. */
export async function readFacts(db: OrgScopedDb): Promise<FactRecord[]> {
  return (await currentFacts(db)).map(toFactRecord)
}

/** The revision the site serves now, and its host while it serves one. */
export async function readSite(
  db: OrgScopedDb,
  suffix: string
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
  return { host: row && live ? siteHost(row.slug, suffix) : null, live }
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
  suffix: string,
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
        readSite(db, suffix),
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
