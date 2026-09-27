import {
  CosCall,
  CosContext,
  CosMessage,
  CosPrefix,
  CosStep,
  CosToolResult,
  CosTurn,
  type TaintLabel,
} from "@workspace/contracts"
import {
  appendSessionEvent,
  conversations,
  eq,
  events,
  type OrgScopedDb,
  sql,
  staff,
} from "@workspace/db"
import { constraint } from "../http.ts"
import { stepMessages } from "./history.ts"

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
 * For a turn's first transaction: another writer appended to the session
 * while this turn was opening. Nothing was written, and the caller answers
 * 409 `chat.busy`.
 */
export class SessionBusy extends Error {
  constructor(readonly sessionId: string) {
    super("cos.session_busy")
  }
}

/** The session is no conversation this org can see. The caller answers 404. */
export class NoSuchSession extends Error {
  constructor(readonly sessionId: string) {
    super("cos.no_such_session")
  }
}

/**
 * An event a turn writes after its first transaction. Taint is the
 * caller's to say from what the payload carries. A step is the model's
 * output, so it is always `inferred`; `cos.call` and `cos.turn` carry no
 * text and no label.
 */
export type TurnEvent =
  | { type: "cos.message"; payload: CosMessage; taint: TaintLabel[] }
  | { type: "cos.tool_result"; payload: CosToolResult; taint: TaintLabel[] }
  | { type: "cos.step"; payload: CosStep }
  | { type: "cos.call"; payload: CosCall }
  | { type: "cos.turn"; payload: CosTurn }

const SCHEMAS = {
  "cos.message": CosMessage,
  "cos.tool_result": CosToolResult,
  "cos.step": CosStep,
  "cos.call": CosCall,
  "cos.turn": CosTurn,
} as const

type Checked = {
  type: TurnEvent["type"]
  payload: { turn_id: string } & Record<string, unknown>
  taint: TaintLabel[]
}

/**
 * The whole batch checked before anything is written: each payload against
 * its contract and naming `turnId`, a step holding only the model's
 * messages, at most one result per call, and nothing after a `cos.turn`.
 */
function checked(turnId: string, writes: TurnEvent[]): Checked[] {
  const calls = new Set<string>()
  return writes.map((write, i) => {
    const payload = SCHEMAS[write.type].parse(write.payload)
    if (payload.turn_id !== turnId) {
      throw new Error(`cos.turns: a ${write.type} for another turn`)
    }
    if (write.type === "cos.turn" && i < writes.length - 1) {
      throw new Error("cos.turns: a write after the turn's cos.turn")
    }
    if (write.type === "cos.step") stepMessages(payload as CosStep)
    if (write.type === "cos.tool_result") {
      const id = (payload as CosToolResult).tool_call_id
      if (calls.has(id)) throw new Error(`cos.turns: a second result for ${id}`)
      calls.add(id)
    }
    const taint: TaintLabel[] =
      write.type === "cos.step"
        ? ["inferred"]
        : "taint" in write
          ? write.taint
          : []
    return { type: write.type, payload, taint }
  })
}

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

/** Whether the session's latest `cos.context` is `turn`'s, with no `cos.turn` after it. */
async function holdsToken(db: OrgScopedDb, turn: Turn): Promise<boolean> {
  const [row] = await db.execute<{ held: boolean }>(sql`
    select c.payload->>'turn_id' = ${turn.turnId} and not exists (
        select 1 from ${events} t
        where t.session_id = c.session_id and t.type = 'cos.turn'
          and t.payload->>'turn_id' = c.payload->>'turn_id'
      ) as held
    from ${events} c
    where c.session_id = ${turn.sessionId} and c.type = 'cos.context'
    order by c.seq desc
    limit 1`)
  return row?.held === true
}

/** The call ids `turn` has logged a result for, among `ids`. */
async function resultsLogged(
  db: OrgScopedDb,
  turn: Turn,
  ids: string[]
): Promise<string[]> {
  if (ids.length === 0) return []
  const rows = await db.execute<{ id: string }>(sql`
    select payload->>'tool_call_id' as id from ${events}
    where session_id = ${turn.sessionId} and type = 'cos.tool_result'
      and payload->>'turn_id' = ${turn.turnId}
      and payload->>'tool_call_id' in ${ids}`)
  return rows.map((row) => row.id)
}

type Open = {
  context: CosContext
  lapsed: boolean
  /** What the turn's `cos.step` rows logged, in USD. */
  logged: number
}

/**
 * The session's open turn, for the paths that may abandon it: its
 * `cos.context`, whether `afterMs` has passed since that was recorded, and
 * its logged spend. Both times are the database's, so a Worker's clock
 * never decides it. Null when the session has no turn or its latest is
 * closed.
 */
async function openTurn(
  db: OrgScopedDb,
  sessionId: string,
  afterMs: number
): Promise<Open | null> {
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
  if (!row || row.closed) return null
  return {
    context: CosContext.parse(row.payload),
    lapsed: row.lapsed,
    logged: Number(row.logged),
  }
}

const abandoned = (found: Open): Checked => ({
  type: "cos.turn",
  payload: CosTurn.parse({
    outcome: "abandoned",
    turn_id: found.context.turn_id,
    logged_usd: found.logged,
    reserved_usd: found.context.reserved_usd,
  }) as Checked["payload"],
  taint: [],
})

/**
 * One event at the session's next seq, as the turn's CoS staff row. Null
 * when a second writer took that seq, which only a writer skipping the lock
 * can do; the caller says what that means for it. The key and the id are
 * fresh per append, so a clash on either is a fault and goes up as it is.
 */
async function append(
  db: OrgScopedDb,
  turn: Omit<Turn, "turnId">,
  write: { type: string; payload: Record<string, unknown>; taint: TaintLabel[] }
): Promise<number | null> {
  try {
    const { seq } = await appendSessionEvent(db, {
      orgId: turn.orgId,
      staffId: turn.staffId,
      assignmentId: null,
      sessionId: turn.sessionId,
      type: write.type,
      payload: write.payload,
      taint: write.taint,
    })
    return seq
  } catch (error) {
    const { code, name } = constraint(error)
    if (code === "23505" && name === "events_session_seq_key") return null
    throw error
  }
}

/**
 * Appends `writes` in order as `turn`, under the conversation's lock, and
 * returns their seqs. The whole batch is checked before the lock is taken,
 * so a bad write leaves nothing behind. Throws `TurnClosed`, having written
 * nothing that commits, when the turn no longer holds the token or another
 * writer took a seq; the caller aborts the turn's stream. A result for a
 * call the turn already logged one for is refused.
 */
export async function writeAsTurn(
  db: OrgScopedDb,
  turn: Turn,
  writes: TurnEvent[]
): Promise<number[]> {
  const batch = checked(turn.turnId, writes)
  await lock(db, turn.sessionId)
  if (!(await holdsToken(db, turn))) throw new TurnClosed(turn.turnId)
  const ids = batch.flatMap((w) =>
    w.type === "cos.tool_result" ? [String(w.payload.tool_call_id)] : []
  )
  const twice = await resultsLogged(db, turn, ids)
  if (twice.length > 0) {
    throw new Error(`cos.turns: a second result for ${twice.join(", ")}`)
  }
  const seqs: number[] = []
  for (const write of batch) {
    const seq = await append(db, turn, write)
    if (seq === null) throw new TurnClosed(turn.turnId)
    seqs.push(seq)
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
  const found = await openTurn(db, turn.sessionId, 0)
  if (found?.context.turn_id !== turn.turnId) {
    throw new TurnClosed(turn.turnId)
  }
  if ((await append(db, turn, abandoned(found))) === null) {
    throw new TurnClosed(turn.turnId)
  }
}

/**
 * For a turn's first transaction: whether the session still has a turn
 * open. A turn open for longer than `totalMs` plus `GRACE_MS` since its
 * `cos.context` is closed here as `abandoned`, which also takes its token,
 * and the answer is false. True means the caller answers `chat.busy`.
 * Throws `NoSuchSession` when the org cannot see the conversation, and
 * `SessionBusy` when another writer appended meanwhile.
 */
export async function closeLapsedTurn(
  db: OrgScopedDb,
  session: Omit<Turn, "turnId">,
  totalMs: number
): Promise<boolean> {
  const [held] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(eq(conversations.id, session.sessionId))
  if (!held) throw new NoSuchSession(session.sessionId)
  await lock(db, session.sessionId)
  const found = await openTurn(db, session.sessionId, totalMs + GRACE_MS)
  if (!found) return false
  if (!found.lapsed) return true
  if ((await append(db, session, abandoned(found))) === null) {
    throw new SessionBusy(session.sessionId)
  }
  return false
}

/** What a turn's first transaction needs from the session's log. */
export type SessionState = {
  /** A turn in the session ended with outcome `integrity`: the model never answers here again. */
  frozen: boolean
  /** The session already holds this prefix. */
  prefixLogged: boolean
  /** A `cos.message` in the session names this message id, so the CoS made it. */
  named: boolean
}

export async function sessionState(
  db: OrgScopedDb,
  sessionId: string,
  prefixSha: string,
  messageId: string | null
): Promise<SessionState> {
  const [row] = await db.execute<SessionState>(sql`
    select
      exists (select 1 from ${events} where session_id = ${sessionId}
        and type = 'cos.turn' and payload->>'outcome' = 'integrity') as frozen,
      exists (select 1 from ${events} where session_id = ${sessionId}
        and type = 'cos.prefix' and payload->>'sha256' = ${prefixSha}) as "prefixLogged",
      exists (select 1 from ${events} where session_id = ${sessionId}
        and type = 'cos.message' and payload->'message'->>'id' = ${messageId ?? ""}) as named`)
  return {
    frozen: row?.frozen === true,
    prefixLogged: row?.prefixLogged === true,
    named: row?.named === true,
  }
}

/** ADR-034's cap on an org's CoS spend per UTC day. */
export const DAILY_CAP_USD = 1

/**
 * Whether the org's CoS spend today, with `amount` added, stays within the
 * cap. It takes the org's budget lock (key 3), always after the
 * conversation's (key 2), and holds it to the end of the transaction, so a
 * second turn in another conversation sums after this one has reserved.
 * Closed turns count their cost, open ones their reservation, and abandoned
 * ones their whole reservation, since their last step's usage is lost. A
 * wait on the lock past the statement limit ends in 57014, which the api
 * answers as 503 `transient`.
 */
export async function withinCap(
  db: OrgScopedDb,
  orgId: string,
  amount: number
): Promise<boolean> {
  await db.execute(
    sql`select pg_advisory_xact_lock(3, hashtext(${orgId}::text))`
  )
  const [row] = await db.execute<{ spent: number }>(sql`
    select coalesce(sum(case
        when t.payload is null then (c.payload->>'reserved_usd')::float8
        when t.payload->>'outcome' = 'abandoned' then (t.payload->>'reserved_usd')::float8
        else (t.payload->>'cost_usd')::float8
      end), 0) as spent
    from ${events} c
    left join ${events} t on t.session_id = c.session_id and t.type = 'cos.turn'
      and t.payload->>'turn_id' = c.payload->>'turn_id'
    where c.org_id = ${orgId} and c.type = 'cos.context'
      and c.occurred_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`)
  return Number(row?.spent ?? 0) + amount <= DAILY_CAP_USD
}

/** A turn's opening writes, in the order the log holds them. */
export type Opening = {
  prefix: CosPrefix | null
  messages: { message: CosMessage["message"]; taint: TaintLabel[] }[]
  context: CosContext
  contextTaint: TaintLabel[]
}

/**
 * For a turn's first transaction, after `closeLapsedTurn` said no turn is
 * open: the prefix when the session lacks it, the turn's messages and its
 * `cos.context`, which gives the turn its token. Throws `SessionBusy` when
 * another writer took a seq meanwhile.
 */
export async function beginTurn(
  db: OrgScopedDb,
  turn: Turn,
  opening: Opening
): Promise<void> {
  const context = CosContext.parse(opening.context)
  if (context.turn_id !== turn.turnId) {
    throw new Error("cos.turns: a context for another turn")
  }
  const writes = [
    ...(opening.prefix
      ? [
          {
            type: "cos.prefix",
            payload: CosPrefix.parse(opening.prefix),
            taint: [],
          },
        ]
      : []),
    ...opening.messages.map(({ message, taint }) => ({
      type: "cos.message",
      payload: CosMessage.parse({ turn_id: turn.turnId, message }),
      taint,
    })),
    { type: "cos.context", payload: context, taint: opening.contextTaint },
  ]
  for (const write of writes) {
    if ((await append(db, turn, write)) === null) {
      throw new SessionBusy(turn.sessionId)
    }
  }
}

/** The org's Chief of Staff staff row, or null for an org made before the starting team. */
export async function chiefStaffId(db: OrgScopedDb): Promise<string | null> {
  const [row] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(eq(staff.staffCode, "COS-001"))
  return row?.id ?? null
}
