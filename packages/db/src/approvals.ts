import { eq, sql } from "drizzle-orm"
import { approvals, assignments, siteRevisions } from "./schema.ts"
import type { OrgScopedDb } from "./tenancy.ts"

/**
 * Revision approvals the orchestrator would take a decision on now, soonest
 * expiry first: undecided, on a build awaiting review and in date, or on a
 * build the sweep parked, where a late decision still counts (ADR-032). One
 * that expired before the hourly sweep parked it is left out, since until
 * then the orchestrator refuses it. A superseded or cancelled build's
 * approval is never decided and never listed. The workspace and the heartbeat
 * both read this, so the owner is never told of an approval they cannot act on.
 */
export function openApprovals(db: OrgScopedDb, now?: Date) {
  const at = now ? sql`${now.toISOString()}::timestamptz` : sql`now()`
  return (
    db
      // A review opens only on a revision that passed the gates, which is
      // numbered by then; the filter says so to the type.
      .select({
        row: approvals,
        version: sql<number>`${siteRevisions.version}`,
      })
      .from(approvals)
      .innerJoin(siteRevisions, eq(siteRevisions.id, approvals.revisionId))
      .innerJoin(assignments, eq(assignments.id, approvals.assignmentId))
      .where(
        sql`${approvals.decision} is null and ${siteRevisions.version} is not null and ((${assignments.state} = 'awaiting_review' and ${approvals.expiresAt} > ${at}) or ${assignments.state} = 'blocked_on_approval')`
      )
      .orderBy(approvals.expiresAt)
  )
}
