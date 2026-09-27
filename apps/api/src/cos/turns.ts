import {
  CosCall,
  CosContext,
  CosMessage,
  CosStep,
  CosToolResult,
  CosTurn,
  type TaintLabel,
} from "@workspace/contracts"
import {
  appendSessionEvent,
  events,
  type OrgScopedDb,
  sql,
} from "@workspace/db"
import { constraint } from "../http.ts"

/**
 * One writer per turn, by token (ADR-034). A turn is open from its
 * `cos.context` to its `cos.turn`, and holds the token while the session's
 * latest `cos.context` is its own and no `cos.turn` has closed it. Every
 * write after the turn's first transaction takes the conversation's lock
 * and checks the token first, so a turn that was closed, by its own end or
 * by the next turn abandoning it, can never write late.
 *
 * `sessionId` is the conversation's id, read under the same `withOrg` as
 * the write, so RLS has said the org holds it. Another org's session has no
 * `cos.context` this org can see, so a write to it is refused like any
 * closed turn.
 */

export type Turn = {
  orgId: string
  /** The org's Chief of Staff staff row. */
  staffId: string
  sessionId: string
  turnId: string
}

/**
 * How long `ctx.waitUntil` may run after the response ends or the client
 * disconnects: up to 30 s (Cloudflare's workers/platform/limits, checked
 * 2026-09-27). A turn is abandoned this long after its `totalMs` has passed.
 */
export const GRACE_MS = 30_000

/** The write's turn no longer holds the token, so nothing was written. */
export class TurnClosed extends Error {
  constructor(readonly turnId: string) {
    super("cos.turn_closed")
  }
}

/**
 * An event a turn writes after its first transaction. Taint is the
 * caller's to say from what the payload carries; `cos.call` and `cos.turn`
 * carry no text and no label.
 */
export type TurnEvent =
  | { type: "cos.message"; payload: CosMessage; taint: TaintLabel[] }
  | { type: "cos.tool_result"; payload: CosToolResult; taint: TaintLabel[] }
  | { type: "cos.step"; payload: CosStep; taint: TaintLabel[] }
  | { type: "cos.call"; payload: CosCall }
  | { type: "cos.turn"; payload: CosTurn }

const SCHEMAS = {
  "cos.message": CosMessage,
  "cos.tool_result": CosToolResult,
  "cos.step": CosStep,
  "cos.call": CosCall,
  "cos.turn": CosTurn,
} as const

/**
 * The conversation's turn lock (ADR-034), the same two-key lock a turn's
 * first transaction tries. This one waits: its holders are short, and the
 * statement limit bounds the wait. Taking it twice in one transaction is a
 * no-op, so a first transaction that tried it already passes straight on.
 */
async function lock(db: OrgScopedDb, sessionId: string): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(2, hashtext(${sessionId}::text))`
  )
}

type Latest = {
  context: CosContext
  closed: boolean
  lapsed: boolean
  /** What the turn's `cos.step` rows logged, in USD. */
  logged: number
}

/**
 * The session's latest turn: its `cos.context`, whether a `cos.turn` closed
 * it, whether `afterMs` has passed since the context was recorded, and its
 * logged spend. Both times are the database's, so a Worker's clock never
 * decides it. Null when the session has no turn.
 */
async function latest(
  db: OrgScopedDb,
  sessionId: string,
  afterMs: number
): Promise<Latest | null> {
  const [row] = await db.execute<{
    payload: unknown
    closed: boolean
    lapsed: boolean
    logged: number
  }>(sql`
    select c.payload,
      exists (
        select 1 from ${events} t
        where t.session_id = c.session_id and t.type = 'cos.turn'
          and t.payload->>'turn_id' = c.payload->>'turn_id'
      ) as closed,
      c.recorded_at + make_interval(secs => ${afterMs / 1000}) <= now() as lapsed,
      (
        select coalesce(sum((s.payload->>'cost_usd')::float8), 0)
        from ${events} s
        where s.session_id = c.session_id and s.type = 'cos.step'
          and s.payload->>'turn_id' = c.payload->>'turn_id'
      ) as logged
    from ${events} c
    where c.session_id = ${sessionId} and c.type = 'cos.context'
    order by c.seq desc
    limit 1`)
  if (!row) return null
  return {
    context: CosContext.parse(row.payload),
    closed: row.closed,
    lapsed: row.lapsed,
    logged: Number(row.logged),
  }
}

const holds = (found: Latest | null, turn: Turn): found is Latest =>
  found?.context.turn_id === turn.turnId && !found.closed

const abandoned = (found: Latest): CosTurn => ({
  outcome: "abandoned",
  turn_id: found.context.turn_id,
  logged_usd: found.logged,
  reserved_usd: found.context.reserved_usd,
})

/** One event at the session's next seq, as the turn's CoS staff row. */
async function append(
  db: OrgScopedDb,
  turn: Turn,
  type: string,
  payload: Record<string, unknown>,
  taint: TaintLabel[] = []
): Promise<number> {
  try {
    const { seq } = await appendSessionEvent(db, {
      orgId: turn.orgId,
      staffId: turn.staffId,
      assignmentId: null,
      sessionId: turn.sessionId,
      type,
      payload,
      taint,
    })
    return seq
  } catch (error) {
    // A second writer took this seq, which only a writer skipping the lock
    // can do: this write loses. The key and the id are fresh per append, so
    // a clash on either is a fault, not a race, and goes up as it is.
    const { code, name } = constraint(error)
    if (code === "23505" && name === "events_session_seq_key") {
      throw new TurnClosed(turn.turnId)
    }
    throw error
  }
}

/**
 * Appends `writes` in order as `turn`, under the conversation's lock, and
 * returns their seqs. Throws `TurnClosed`, having written nothing that
 * commits, when the turn no longer holds the token; the caller aborts the
 * turn's stream. Each payload is checked against its contract and must name
 * this turn.
 */
export async function writeAsTurn(
  db: OrgScopedDb,
  turn: Turn,
  writes: TurnEvent[]
): Promise<number[]> {
  await lock(db, turn.sessionId)
  if (!holds(await latest(db, turn.sessionId, 0), turn)) {
    throw new TurnClosed(turn.turnId)
  }
  const seqs: number[] = []
  for (const write of writes) {
    const payload = SCHEMAS[write.type].parse(write.payload)
    if (payload.turn_id !== turn.turnId) {
      throw new Error(`cos.turns: a ${write.type} for another turn`)
    }
    const taint = "taint" in write ? write.taint : []
    seqs.push(await append(db, turn, write.type, payload, taint))
  }
  return seqs
}

/**
 * A run that aborted closes its own turn at once (ADR-034, "the budget
 * lock and the stream"): `cos.turn` with outcome `abandoned`, the spend its
 * steps logged and its reservation, under its own token.
 */
export async function abandonTurn(db: OrgScopedDb, turn: Turn): Promise<void> {
  await lock(db, turn.sessionId)
  const found = await latest(db, turn.sessionId, 0)
  if (!holds(found, turn)) throw new TurnClosed(turn.turnId)
  await append(db, turn, "cos.turn", abandoned(found))
}

/**
 * For a turn's first transaction: whether the session still has a turn
 * open. A turn open for longer than `totalMs` plus `GRACE_MS` since its
 * `cos.context` is closed here as `abandoned`, which also takes its token,
 * and the answer is false. True means the caller answers `chat.busy`.
 */
export async function closeLapsedTurn(
  db: OrgScopedDb,
  session: Omit<Turn, "turnId">,
  totalMs: number
): Promise<boolean> {
  await lock(db, session.sessionId)
  const found = await latest(db, session.sessionId, totalMs + GRACE_MS)
  if (!found || found.closed) return false
  if (!found.lapsed) return true
  const turn = { ...session, turnId: found.context.turn_id }
  await append(db, turn, "cos.turn", abandoned(found))
  return false
}
