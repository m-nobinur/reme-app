import {
  approvals,
  assignments,
  events,
  type OrgScopedDb,
  siteRevisions,
  sql,
  type Tenancy,
} from "@workspace/db"
import { activeDeployment, redriveQueued } from "./publish.ts"
import {
  appendEvent,
  lockRow,
  retireAfter,
  TransitionError,
  transition,
} from "./state.ts"

/**
 * Retention (ADR-031, ADR-032): two revisions per site stay, the rest are
 * retired and their files deleted seven days on. Marking happens after a
 * publish (`retireOthers`) and when a build ends in `cancelled` or `failed`
 * (inside `transition()`); deleting happens here and nowhere else, from the
 * hourly sweep, behind open item 47's guards.
 */

type Revision = typeof siteRevisions.$inferSelect

/**
 * After a publish: every `published` revision of the site other than the
 * active one and the previous one, read from the deployments at this
 * moment, so a rollback in between is honoured. A row already retired keeps
 * its date. Candidates under review are `preview`, never `published`, and a
 * build in progress is `building`; neither is touched (ADR-031).
 */
export async function retireOthers(
  db: OrgScopedDb,
  siteId: string,
  now: Date = new Date()
): Promise<string[]> {
  const active = await activeDeployment(db, siteId)
  if (!active) return []
  const keep = [active.revisionId, active.previousRevisionId].filter(
    (id): id is string => typeof id === "string"
  )
  const rows = await db
    .update(siteRevisions)
    .set({ status: "retired", retireAfter: retireAfter(now), updatedAt: now })
    .where(
      sql`${siteRevisions.siteId} = ${siteId} and ${siteRevisions.status} = 'published' and ${siteRevisions.retireAfter} is null and ${siteRevisions.id} not in (${sql.join(
        keep.map((id) => sql`${id}`),
        sql`, `
      )})`
    )
    .returning({ id: siteRevisions.id })
  return rows.map((r) => r.id)
}

/**
 * Retired revisions whose window has passed and whose files are still there,
 * the last read from the log: one `revision.files_deleted` event per deleted
 * revision, so an emptied prefix is not listed again every hour.
 *
 * ponytail: the `not exists` scans this org's events; a `files_deleted_at`
 * column on site_revisions is the upgrade when that query shows in the slow
 * log or retired revisions per org pass four figures.
 */
export function dueRevisions(
  db: OrgScopedDb,
  now: Date = new Date()
): Promise<Revision[]> {
  return db
    .select()
    .from(siteRevisions)
    .where(
      sql`${siteRevisions.status} = 'retired' and ${siteRevisions.retireAfter} <= ${now.toISOString()}::timestamptz and not exists (select 1 from ${events} where ${events.type} = 'revision.files_deleted' and ${events.payload}->>'revision_id' = ${siteRevisions.id}::text)`
    )
    .orderBy(siteRevisions.retireAfter)
}

/** The slice of R2 the delete uses. */
export type Deletable = {
  list: (options: { prefix: string; cursor?: string }) => Promise<{
    objects: { key: string }[]
    truncated: boolean
    cursor?: string
  }>
  delete: (keys: string[]) => Promise<void>
}

/** The most keys one R2 delete takes. */
const DELETE_BATCH = 1000

/**
 * The one path that deletes tenant files (open item 47). The guards are
 * asserted here, whoever calls: the revision is `retired`, its window has
 * passed, and it is neither what the site serves nor what a rollback would
 * restore. Everything under `sites/{site}/{rev}/` goes, the source snapshot
 * included: a revise restores from the published revision, never a retired
 * one (ADR-031). One event names the keys. An empty prefix appends one only
 * when the revision has none yet: a run cut off after its deletes and before
 * its event (the idle limit, a lost connection) would otherwise leave the
 * revision due, and listed, for good. A second run deletes nothing and says
 * nothing.
 */
export async function deleteRevisionFiles(
  sites: Deletable,
  db: OrgScopedDb,
  revision: Revision,
  now: Date = new Date()
): Promise<{ keys: string[] }> {
  const guard = (why: string) =>
    new TransitionError("retention.guarded", "validation", why)
  if (revision.status !== "retired") throw guard("the revision is not retired")
  if (!revision.retireAfter || revision.retireAfter.getTime() > now.getTime())
    throw guard("the revision's window has not passed")
  const active = await activeDeployment(db, revision.siteId)
  if (active?.revisionId === revision.id)
    throw guard("the revision is what the site serves")
  if (active?.previousRevisionId === revision.id)
    throw guard("the revision is what a rollback would restore")

  const prefix = `sites/${revision.siteId}/${revision.id}/`
  const keys: string[] = []
  let cursor: string | undefined
  do {
    const page = await sites.list({ prefix, cursor })
    keys.push(...page.objects.map((o) => o.key))
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  for (let i = 0; i < keys.length; i += DELETE_BATCH) {
    await sites.delete(keys.slice(i, i + DELETE_BATCH))
  }
  const settled =
    keys.length === 0 &&
    (
      await db.execute(
        sql`select 1 from ${events} where ${events.type} = 'revision.files_deleted' and ${events.payload}->>'revision_id' = ${revision.id}::text limit 1`
      )
    ).length > 0
  if (!settled) {
    await appendEvent(db, {
      orgId: revision.orgId,
      assignmentId: revision.assignmentId,
      staffId: null,
      type: "revision.files_deleted",
      payload: { revision_id: revision.id, keys, count: keys.length },
    })
  }
  return { keys }
}

/**
 * §13: a review the owner never answered parks after 72 hours. The request
 * stays open and undecided, so a late approval is still a human act that
 * publishes (ADR-032); `decideApproval` accepts it from the park.
 */
export async function parkExpiredReviews(
  db: OrgScopedDb,
  now: Date = new Date()
): Promise<string[]> {
  const expired = await db
    .select({ id: assignments.id })
    .from(assignments)
    .innerJoin(
      approvals,
      sql`${approvals.assignmentId} = ${assignments.id} and ${approvals.decision} is null`
    )
    .where(
      sql`${assignments.state} = 'awaiting_review' and ${approvals.expiresAt} <= ${now.toISOString()}::timestamptz`
    )
  const parked: string[] = []
  for (const { id } of expired) {
    const row = await lockRow(db, id)
    if (row.state !== "awaiting_review") continue
    await transition(db, {
      orgId: row.orgId,
      assignmentId: row.id,
      to: "blocked_on_approval",
      expectedVersion: row.version,
      reason: "review.expired",
    })
    parked.push(row.id)
  }
  return parked
}

export type SweepCounts = {
  parked: number
  redriven: number
  deleted: number
}

/**
 * One org's hour: park what expired, re-drive what queued, delete what is
 * due. Every part is idempotent, so a retried chunk redoing a finished org
 * changes nothing. One `retention.swept` event per org that had work.
 */
export async function sweepOrg(
  env: Pick<Env, "ASSIGNMENTS" | "SITES">,
  kit: Tenancy,
  orgId: string,
  now: Date = new Date()
): Promise<SweepCounts> {
  const parked = await kit.withOrg({ orgId }, (db) =>
    parkExpiredReviews(db, now)
  )
  const redriven = await redriveQueued(env, kit, orgId)
  const due = await kit.withOrg({ orgId }, (db) => dueRevisions(db, now))
  let deleted = 0
  for (const revision of due) {
    const { keys } = await kit.withOrg({ orgId }, (db) =>
      deleteRevisionFiles(env.SITES, db, revision, now)
    )
    if (keys.length > 0) deleted++
  }
  const counts = { parked: parked.length, redriven: redriven.length, deleted }
  if (counts.parked + counts.redriven + counts.deleted > 0) {
    await kit.withOrg({ orgId }, (db) =>
      appendEvent(db, {
        orgId,
        assignmentId: null,
        staffId: null,
        type: "retention.swept",
        payload: { ...counts, at: now.toISOString() },
      })
    )
  }
  return counts
}
