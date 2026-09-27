import type { TaintLabel } from "@workspace/contracts"
import { sql } from "drizzle-orm"
import { ulid } from "ulid"
import { events } from "./schema.ts"
import type { OrgScopedDb } from "./tenancy.ts"

export type AppendEvent = {
  orgId: string
  /** Null for an org-level row that belongs to no assignment (a probe). */
  assignmentId: string | null
  staffId: string | null
  type: string
  payload: Record<string, unknown>
  taint?: TaintLabel[]
}

export type AppendSessionEvent = AppendEvent & { sessionId: string }

/**
 * One row in `events`, belonging to no session (ADR-028). A fresh ULID is safe
 * as the idempotency key only because every caller appends inside the same
 * transaction as the write it describes: the two commit or roll back together.
 */
export async function appendEvent(
  db: OrgScopedDb,
  event: AppendEvent
): Promise<string> {
  const eventId = ulid()
  await db.insert(events).values({
    eventId,
    orgId: event.orgId,
    staffId: event.staffId,
    assignmentId: event.assignmentId,
    sessionId: null,
    seq: null,
    type: event.type,
    occurredAt: new Date(),
    idempotencyKey: ulid(),
    taint: event.taint ?? [],
    payload: event.payload,
  })
  return eventId
}

/**
 * One row in a session's stream (ADR-034), at the seq after the session's
 * last one, read and written in the same statement. The caller must be the
 * stream's single writer. A second writer that reads the same last seq
 * collides on `events_session_seq_key` and fails with 23505 once the first
 * commits, so its transaction rolls back rather than interleaving. The
 * idempotency key is a fresh ULID on the same terms as `appendEvent`.
 */
export async function appendSessionEvent(
  db: OrgScopedDb,
  event: AppendSessionEvent
): Promise<{ eventId: string; seq: number }> {
  const eventId = ulid()
  const [row] = await db
    .insert(events)
    .values({
      eventId,
      orgId: event.orgId,
      staffId: event.staffId,
      assignmentId: event.assignmentId,
      sessionId: event.sessionId,
      seq: sql`(select coalesce(max(${events.seq}), -1) + 1 from ${events} where ${events.sessionId} = ${event.sessionId})`,
      type: event.type,
      occurredAt: new Date(),
      idempotencyKey: ulid(),
      taint: event.taint ?? [],
      payload: event.payload,
    })
    .returning({ seq: events.seq })
  return { eventId, seq: Number(row?.seq) }
}
