import {
  ActivityFeed,
  ApprovalRequest,
  type AttentionItem,
  type BuildSummary,
  type FactRecord,
  FactValueKey,
  InformationRequest,
  SiteFields,
  WorkspaceStatus,
} from "@workspace/contracts"
import {
  approvals,
  assignments,
  assignmentTransitions,
  eq,
  events,
  facts,
  type OrgScopedDb,
  orgs,
  siteRevisions,
  sql,
  type Tenancy,
  toFactRecord,
} from "@workspace/db"
import { factsToAsk } from "@workspace/gates/fields"
import { fields } from "@workspace/starter-site/site-config"

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
 * Site builds that have not finished, newest first, each with its latest
 * revision. The panel caps the list; routing a change reads all of them.
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
      // Written out rather than interpolated: in a one-table select drizzle
      // drops the table name, and a bare `id` here would mean the revision's.
      revision: sql<RevisionRef | null>`(select json_build_object('revision_id', r.id, 'version', r.version) from site_revisions r where r.assignment_id = assignments.id order by r.version desc limit 1)`,
    })
    .from(assignments)
    .where(
      sql`${assignments.kind} in ('site.build', 'site.revise') and ${assignments.state} not in ('published', 'failed', 'cancelled')`
    )
    .orderBy(sql`${assignments.createdAt} desc`)
  const rows = await (limit === null ? query : query.limit(limit))
  return rows.map((row) => ({
    assignment_id: row.id,
    kind: row.kind as BuildSummary["kind"],
    state: row.state,
    goal: row.goal,
    revision: row.revision,
    created_at: iso(row.createdAt),
    updated_at: iso(row.updatedAt),
  }))
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
    .select({ row: approvals, version: siteRevisions.version })
    .from(approvals)
    .innerJoin(siteRevisions, eq(siteRevisions.id, approvals.revisionId))
    .innerJoin(assignments, eq(assignments.id, approvals.assignmentId))
    .where(
      sql`${approvals.decision} is null and ((${assignments.state} = 'awaiting_review' and ${approvals.expiresAt} > now()) or ${assignments.state} = 'blocked_on_approval')`
    )
    .orderBy(approvals.expiresAt)
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
  }))
}

/**
 * The question each waiting build is blocked on, oldest first, or only
 * `assignmentId`'s. The build's latest transition to
 * `blocked_on_information` names it by `request_id` in its event. A block
 * that names none (a resume from a pause logs only the states) falls back to
 * the build's latest question. Either way, an answered question is not
 * waited on. A build that asked twice waits on its second question, so the
 * owner's answer path reads this too and refuses any other.
 */
export async function readQuestions(
  db: OrgScopedDb,
  assignmentId: string | null = null
): Promise<Extract<AttentionItem, { kind: "question" }>[]> {
  const rows = await db.execute<{ payload: unknown }>(sql`
    select q.payload
    from ${assignments} a
    cross join lateral (
      select b.payload->>'request_id' as request_id
      from ${assignmentTransitions} t
      join ${events} b on b.event_id = t.event_id
      where t.assignment_id = a.id and t.to_state = 'blocked_on_information'
      order by t.version desc
      limit 1
    ) latest
    cross join lateral (
      select e.payload
      from ${events} e
      where e.assignment_id = a.id
        and e.type = 'information.requested'
        and (latest.request_id is null or e.payload->>'request_id' = latest.request_id)
        and not exists (
          select 1 from ${events} answered
          where answered.assignment_id = a.id
            and answered.type = 'information.answered'
            and answered.payload->>'request_id' = e.payload->>'request_id')
      order by e.event_id desc
      limit 1
    ) q
    where a.state = 'blocked_on_information'
      and (${assignmentId}::uuid is null or a.id = ${assignmentId}::uuid)
    order by q.payload->>'requested_at'`)
  return rows.map((row) => ({
    kind: "question",
    request: InformationRequest.parse(row.payload),
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
  const rows = await db
    .select()
    .from(facts)
    .where(sql`${facts.validTo} is null`)
    .orderBy(facts.key)
  return rows.map(toFactRecord)
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
      live: sql<RevisionRef | null>`(select json_build_object('revision_id', r.id, 'version', r.version) from deployments d join site_revisions r on r.id = d.revision_id where d.site_id = orgs.id order by d.config_version desc limit 1)`,
    })
    .from(orgs)
    .limit(1)
  const live = row?.live ?? null
  return { host: row && live ? `${row.slug}${suffix}` : null, live }
}

/** Required facts the org does not hold yet, minus the ones it keeps off the site. */
function missingFacts(current: FactRecord[]): FactValueKey[] {
  const held = new Set(current.map((fact) => fact.key))
  return factsToAsk(FIELDS, current).ask.filter(
    (key): key is FactValueKey =>
      !held.has(key) && FactValueKey.safeParse(key).success
  )
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

/** Reports and alerts stay in the panel for a day; `/activity` keeps 30. */
const PANEL_HOURS = 24

export async function readWorkspace(
  kit: Tenancy,
  orgId: string,
  suffix: string
): Promise<WorkspaceStatus> {
  return kit.withOrg({ orgId }, async (db) => {
    // Issued together, so postgres.js pipelines them on the transaction's one
    // connection instead of paying a round trip each.
    const [builds, approvalItems, questions, feed, current, site] =
      await Promise.all([
        readBuilds(db),
        readApprovals(db),
        readQuestions(db),
        readFeed(db, PANEL_HOURS, 10),
        readFacts(db),
        readSite(db, suffix),
      ])
    return WorkspaceStatus.parse({
      site,
      builds,
      attention: orderAttention(approvalItems, questions, feed),
      missing_facts: missingFacts(current),
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
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(body)
  )
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
  return `"${hex.slice(0, 32)}"`
}

/** Whether an `If-None-Match` header names this tag, weak or strong. */
export function unchanged(header: string | null, tag: string): boolean {
  if (!header) return false
  return header
    .split(",")
    .some((each) => each.trim().replace(/^W\//, "") === tag)
}
