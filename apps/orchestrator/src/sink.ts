import type { EventEnvelope } from "@workspace/contracts"
import { events, sql, type Tenancy } from "@workspace/db"
import type { EventSink } from "@workspace/facade"

/**
 * The facade's write path into `events` (architect ruling 2): two functions
 * over `withOrg`, and the append refuses a batch that is not contiguous with
 * the session's last `seq`, so a gap is a typed refusal here rather than a
 * silent hole `deriveContext` finds later. The unique index is the second
 * line; this is the first.
 */
export function eventSink(kit: Tenancy, orgId: string): EventSink {
  const lastSeq = (sessionId: string) =>
    kit.withOrg({ orgId }, async (db) => {
      const [row] = await db
        .select({ max: sql<number | null>`max(${events.seq})` })
        .from(events)
        .where(sql`${events.sessionId} = ${sessionId}`)
      return row?.max === null || row?.max === undefined
        ? null
        : Number(row.max)
    })
  return {
    lastSeq,
    append: async (rows) => {
      const first = rows[0]
      if (!first || first.session_id === null) return
      const last = await lastSeq(first.session_id)
      if (first.seq !== (last ?? -1) + 1) {
        throw new SeqGapError(first.session_id, last, first.seq)
      }
      await kit.withOrg({ orgId }, (db) =>
        db.insert(events).values(rows.map(toEventRow))
      )
    },
  }
}

/** §28.1 `validation`: the batch does not follow the stream. */
export class SeqGapError extends Error {
  readonly code = "events.seq_gap"
  readonly errorClass = "validation"
  constructor(sessionId: string, last: number | null, got: number | null) {
    super(`session ${sessionId}: last seq is ${last}, batch starts at ${got}`)
    this.name = "SeqGapError"
  }
}

/** The reverse of `toEventEnvelope` in @workspace/db. */
export function toEventRow(row: EventEnvelope): typeof events.$inferInsert {
  return {
    eventId: row.event_id,
    orgId: row.org_id,
    staffId: row.staff_id,
    assignmentId: row.assignment_id,
    sessionId: row.session_id,
    seq: row.seq,
    type: row.type,
    occurredAt: new Date(row.occurred_at),
    idempotencyKey: row.idempotency_key,
    taint: row.taint,
    payload: row.payload,
  }
}
