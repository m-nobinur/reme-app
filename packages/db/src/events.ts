import type { TaintLabel } from "@workspace/contracts"
import { type SQL, sql } from "drizzle-orm"
import { monotonicFactory } from "ulid"
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

export type AppendSessionEvent = AppendEvent & {
  sessionId: string
  /** A ULID the caller keeps to retry with. Defaults to a fresh one. */
  idempotencyKey?: string
}

// Marked pure so a bundle that never makes an id, such as the router's, drops
// it and `ulid`.
const monotonic = /* @__PURE__ */ monotonicFactory()

/**
 * The ULID source for everything that imports `@workspace/db` (ADR-034); the
 * facade, which cannot, keeps its own monotonic factory. `event_id` is the
 * append order, and a Worker's clock stands still within a request, so plain
 * `ulid()` would order same-millisecond ids at random. The monotonic factory
 * increments the random part instead, so ids made in one isolate sort in the
 * order they were made.
 */
export function newUlid(): string {
  return monotonic()
}

/** The row both appenders write. `session` is null for a sessionless event. */
function row(
  event: AppendEvent,
  session: { sessionId: string; seq: SQL } | null,
  idempotencyKey: string
) {
  return {
    eventId: newUlid(),
    orgId: event.orgId,
    staffId: event.staffId,
    assignmentId: event.assignmentId,
    sessionId: session?.sessionId ?? null,
    seq: session?.seq ?? null,
    type: event.type,
    occurredAt: new Date(),
    idempotencyKey,
    taint: event.taint ?? [],
    payload: event.payload,
  }
}

/**
 * One row in `events`, belonging to no session (ADR-028). A fresh ULID is safe
 * as the idempotency key only because every caller appends inside the same
 * transaction as the write it describes: the two commit or roll back together.
 */
export async function appendEvent(
  db: OrgScopedDb,
  event: AppendEvent
): Promise<string> {
  const values = row(event, null, newUlid())
  await db.insert(events).values(values)
  return values.eventId
}

/**
 * One row in a session's stream (ADR-034), at the seq after the session's
 * last one, read and written in the same statement. The caller must be the
 * stream's single writer. A second writer that reads the same last seq
 * collides on `events_session_seq_key` and fails with 23505 once the first
 * commits, so its transaction rolls back rather than interleaving.
 *
 * `sessionId` must come from a conversation row read under the same
 * `withOrg`: the seq index spans orgs, so another org's session id collides
 * with rows this caller cannot see. A retry that passes the same
 * `idempotencyKey` fails with 23505 on `events_org_idempotency_key` and writes
 * no second seq. The caller decides what that refusal means.
 */
export async function appendSessionEvent(
  db: OrgScopedDb,
  event: AppendSessionEvent
): Promise<{ eventId: string; seq: number }> {
  const seq = sql`(select coalesce(max(${events.seq}), -1) + 1 from ${events} where ${events.sessionId} = ${event.sessionId})`
  const values = row(
    event,
    { sessionId: event.sessionId, seq },
    event.idempotencyKey ?? newUlid()
  )
  const [written] = await db
    .insert(events)
    .values(values)
    .returning({ seq: events.seq })
  if (written?.seq == null) {
    throw new Error(`session ${event.sessionId}: the insert returned no seq`)
  }
  return { eventId: values.eventId, seq: written.seq }
}
