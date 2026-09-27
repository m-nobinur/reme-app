import {
  appendSessionEvent,
  conversations,
  eq,
  events,
  newUlid,
  sql,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  CONTEXT_POLICY,
  deriveCosMessages,
  readSession,
  sha256,
} from "../src/cos/history.ts"
import {
  abandonTurn,
  closeLapsedTurn,
  GRACE_MS,
  type Turn,
  TurnClosed,
  writeAsTurn,
} from "../src/cos/turns.ts"
import { type Owner, owner } from "./owner-fixture.ts"

/**
 * The turn token and abandonment (ADR-034) on a live connection. Every
 * session id here is a conversation id read under the same `withOrg` as the
 * writes that use it, as a turn's first transaction reads it.
 */

const url = process.env.DATABASE_URL
const SHA = "b".repeat(64)
const TOTAL_MS = 60_000

describe.skipIf(!url)("the CoS turn writers, on a live connection", () => {
  const kit: Tenancy = tenancy(url as string, { max: 3 })
  let me: Owner
  let other: Owner

  beforeAll(async () => {
    me = await owner(kit, url as string, "cos-turns")
    other = await owner(kit, url as string, "cos-turns-other")
  }, 60_000)

  afterAll(() => kit.close())

  /** A new conversation of `who`'s, its id read back under RLS. */
  const conversation = (who: Owner) =>
    kit.withOrg({ orgId: who.orgId }, async (db) => {
      const [made] = await db
        .insert(conversations)
        .values({
          orgId: who.orgId,
          kind: "assistant",
          createdByStaffId: who.chiefId,
        })
        .returning({ id: conversations.id })
      const [read] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, made?.id as string))
      return read?.id as string
    })

  const turnIn = (who: Owner, sessionId: string): Turn => ({
    orgId: who.orgId,
    staffId: who.chiefId,
    sessionId,
    turnId: newUlid(),
  })

  const contextOf = (turn: Turn, reserved = 0.017) => ({
    turn_id: turn.turnId,
    prefix_sha256: SHA,
    context_policy_version: CONTEXT_POLICY.version,
    mode: "ask" as const,
    active_tools: ["get_workspace" as const],
    text: "Mode: ask.",
    reserved_usd: reserved,
  })

  /**
   * A turn's `cos.context`, as its first transaction appends it, recorded
   * `ageMs` ago by the database's clock.
   */
  const open = (turn: Turn, ageMs = 0, reserved = 0.017) =>
    kit.withOrg({ orgId: turn.orgId }, (db) =>
      db.insert(events).values({
        eventId: newUlid(),
        orgId: turn.orgId,
        staffId: turn.staffId,
        assignmentId: null,
        sessionId: turn.sessionId,
        seq: sql`(select coalesce(max(${events.seq}), -1) + 1 from ${events} where ${events.sessionId} = ${turn.sessionId})`,
        type: "cos.context",
        occurredAt: new Date(),
        recordedAt: sql`now() - make_interval(secs => ${ageMs / 1000})`,
        idempotencyKey: newUlid(),
        payload: contextOf(turn, reserved),
      })
    )

  const step = (turn: Turn, n: number, cost: number) => ({
    type: "cos.step" as const,
    payload: {
      turn_id: turn.turnId,
      step: n,
      messages: [{ role: "assistant", content: "..." }],
      usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
      cost_usd: cost,
    },
    taint: ["inferred" as const],
  })

  const call = (turn: Turn, n = 0) => ({
    type: "cos.call" as const,
    payload: { turn_id: turn.turnId, step: n, sha256: SHA },
  })

  /** The session's rows as `who` reads them, in seq order. */
  const log = (who: Owner, sessionId: string) =>
    kit.withOrg({ orgId: who.orgId }, (db) =>
      db
        .select({
          seq: events.seq,
          type: events.type,
          staffId: events.staffId,
          taint: events.taint,
          payload: events.payload,
        })
        .from(events)
        .where(eq(events.sessionId, sessionId))
        .orderBy(events.seq)
    )

  const write = (turn: Turn, writes: Parameters<typeof writeAsTurn>[2]) =>
    kit.withOrg({ orgId: turn.orgId }, (db) => writeAsTurn(db, turn, writes))

  const lapsed = (who: Owner, sessionId: string, totalMs = TOTAL_MS) =>
    kit.withOrg({ orgId: who.orgId }, (db) =>
      closeLapsedTurn(
        db,
        { orgId: who.orgId, staffId: who.chiefId, sessionId },
        totalMs
      )
    )

  it("appends an open turn's writes at the session's next seqs, as the CoS", async () => {
    const turn = turnIn(me, await conversation(me))
    await open(turn)
    const seqs = await write(turn, [step(turn, 0, 0.002), call(turn, 1)])
    expect(seqs).toEqual([1, 2])
    const rows = await log(me, turn.sessionId)
    expect(rows.map((r) => [r.seq, r.type])).toEqual([
      [0, "cos.context"],
      [1, "cos.step"],
      [2, "cos.call"],
    ])
    expect(rows.every((r) => r.staffId === me.chiefId)).toBe(true)
    expect(rows[1]?.taint).toEqual(["inferred"])
    expect(rows[2]?.taint).toEqual([])
  })

  it("refuses a write from a turn that is not the session's latest", async () => {
    const sessionId = await conversation(me)
    const old = turnIn(me, sessionId)
    const next = turnIn(me, sessionId)
    await open(old)
    await open(next)
    await expect(write(old, [call(old)])).rejects.toBeInstanceOf(TurnClosed)
    expect((await log(me, sessionId)).length).toBe(2)
  })

  it("refuses a write from a turn its own cos.turn closed", async () => {
    const turn = turnIn(me, await conversation(me))
    await open(turn)
    await write(turn, [
      {
        type: "cos.turn",
        payload: {
          outcome: "answered",
          turn_id: turn.turnId,
          model: "deepseek/deepseek-v4.1-flash",
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
          cost_usd: 0,
          tools: [],
          steps: 1,
          first_chunk_ms: 900,
        },
      },
    ])
    await expect(write(turn, [call(turn)])).rejects.toBeInstanceOf(TurnClosed)
  })

  it("refuses a write to a session with no turn", async () => {
    const turn = turnIn(me, await conversation(me))
    await expect(write(turn, [call(turn)])).rejects.toBeInstanceOf(TurnClosed)
  })

  it("refuses a write to another org's session, and it writes nothing there", async () => {
    const theirs = turnIn(other, await conversation(other))
    await open(theirs)
    const forged = { ...theirs, orgId: me.orgId, staffId: me.chiefId }
    await expect(write(forged, [call(forged)])).rejects.toBeInstanceOf(
      TurnClosed
    )
    expect((await log(other, theirs.sessionId)).length).toBe(1)
  })

  it("refuses a payload that names another turn, or is off its contract", async () => {
    const turn = turnIn(me, await conversation(me))
    await open(turn)
    const stranger = { ...turn, turnId: newUlid() }
    await expect(write(turn, [call(stranger)])).rejects.toThrow(/another turn/)
    await expect(
      write(turn, [
        { type: "cos.call", payload: { turn_id: turn.turnId } as never },
      ])
    ).rejects.toThrow()
    expect((await log(me, turn.sessionId)).length).toBe(1)
  })

  it("queues two writes of one turn, as parallel tool calls make them", async () => {
    const turn = turnIn(me, await conversation(me))
    await open(turn)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let wrote!: () => void
    const first = new Promise<void>((resolve) => {
      wrote = resolve
    })
    // The first write stays uncommitted until released, so the second
    // overlaps it.
    const one = kit.withOrg({ orgId: me.orgId }, async (db) => {
      await writeAsTurn(db, turn, [step(turn, 0, 0.001)])
      wrote()
      await held
    })
    await first
    const two = write(turn, [call(turn)])
    setTimeout(release, 300)
    await one
    expect(await two).toEqual([2])
    expect((await log(me, turn.sessionId)).map((r) => r.type)).toEqual([
      "cos.context",
      "cos.step",
      "cos.call",
    ])
  })

  it("loses to a second writer that took the seq, and writes nothing", async () => {
    const turn = turnIn(me, await conversation(me))
    await open(turn)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    // A writer that skips the lock: it takes seq 1 and holds it uncommitted.
    let taken!: () => void
    const took = new Promise<void>((resolve) => {
      taken = resolve
    })
    const rogue = kit.withOrg({ orgId: me.orgId }, async (db) => {
      await appendSessionEvent(db, {
        orgId: me.orgId,
        staffId: me.chiefId,
        assignmentId: null,
        sessionId: turn.sessionId,
        type: "cos.call",
        payload: { turn_id: turn.turnId, step: 9, sha256: SHA },
      })
      taken()
      await held
    })
    await took
    const writing = write(turn, [call(turn)])
    setTimeout(release, 300)
    await rogue
    await expect(writing).rejects.toBeInstanceOf(TurnClosed)
    expect((await log(me, turn.sessionId)).map((r) => r.seq)).toEqual([0, 1])
  })

  it("keeps a turn open until totalMs plus the grace has passed", async () => {
    const turn = turnIn(me, await conversation(me))
    await open(turn, TOTAL_MS + GRACE_MS - 5_000)
    expect(await lapsed(me, turn.sessionId)).toBe(true)
    // Still open, so it still writes.
    await write(turn, [call(turn)])
    expect((await log(me, turn.sessionId)).map((r) => r.type)).toEqual([
      "cos.context",
      "cos.call",
    ])
  })

  it("abandons a lapsed turn with its logged spend, and refuses its next write", async () => {
    const turn = turnIn(me, await conversation(me))
    await open(turn, 0, 0.017)
    await write(turn, [step(turn, 0, 0.002), step(turn, 1, 0.003)])
    // Recorded now, so only a totalMs that ends before the grace does lapses it.
    expect(await lapsed(me, turn.sessionId, -GRACE_MS)).toBe(false)
    const rows = await log(me, turn.sessionId)
    expect(rows.at(-1)).toMatchObject({
      type: "cos.turn",
      staffId: me.chiefId,
      taint: [],
      payload: {
        outcome: "abandoned",
        turn_id: turn.turnId,
        logged_usd: 0.005,
        reserved_usd: 0.017,
      },
    })
    await expect(write(turn, [call(turn)])).rejects.toBeInstanceOf(TurnClosed)
    // Closed once: a second look finds nothing open and appends nothing.
    expect(await lapsed(me, turn.sessionId, -GRACE_MS)).toBe(false)
    expect((await log(me, turn.sessionId)).length).toBe(rows.length)
  })

  it("abandons a turn whose context is older than totalMs plus the grace", async () => {
    const turn = turnIn(me, await conversation(me))
    await open(turn, TOTAL_MS + GRACE_MS + 1_000)
    expect(await lapsed(me, turn.sessionId)).toBe(false)
    expect((await log(me, turn.sessionId)).at(-1)?.payload).toMatchObject({
      outcome: "abandoned",
      turn_id: turn.turnId,
      logged_usd: 0,
    })
  })

  it("finds nothing open in a session with no turn", async () => {
    expect(await lapsed(me, await conversation(me))).toBe(false)
  })

  it("lets an aborted run close its own turn at once, so the next need not wait", async () => {
    const turn = turnIn(me, await conversation(me))
    await open(turn, 0, 0.017)
    await write(turn, [step(turn, 0, 0.004)])
    await kit.withOrg({ orgId: me.orgId }, (db) => abandonTurn(db, turn))
    expect((await log(me, turn.sessionId)).at(-1)?.payload).toEqual({
      outcome: "abandoned",
      turn_id: turn.turnId,
      logged_usd: 0.004,
      reserved_usd: 0.017,
    })
    expect(await lapsed(me, turn.sessionId)).toBe(false)
    await expect(
      kit.withOrg({ orgId: me.orgId }, (db) => abandonTurn(db, turn))
    ).rejects.toBeInstanceOf(TurnClosed)
  })

  it("derives the same hash from the rows read back as from the events written", async () => {
    const turn = turnIn(me, await conversation(me))
    await open(turn)
    const message = {
      turn_id: turn.turnId,
      message: {
        role: "user" as const,
        id: "m1",
        parts: [{ type: "text", text: "Is my site live?" }],
      },
    }
    const result = {
      turn_id: turn.turnId,
      tool_call_id: "call_1",
      tool: "get_workspace" as const,
      output: {
        site: { live_version: null, host: null },
        builds: [],
        questions: [],
        approvals: [],
        missing_facts: [],
      },
    }
    // Keys in the order the SDK writes a tool part, which jsonb does not keep.
    const reply = {
      turn_id: turn.turnId,
      message: {
        id: "a1",
        role: "assistant" as const,
        parts: [
          {
            type: "tool-get_workspace",
            toolCallId: "call_1",
            state: "input-available",
            input: {},
          },
        ],
      },
    }
    const logged = step(turn, 0, 0.001)
    await write(turn, [
      { type: "cos.message", payload: message, taint: ["untrusted_input"] },
      { type: "cos.message", payload: reply, taint: ["inferred"] },
      { type: "cos.tool_result", payload: result, taint: [] },
      logged,
    ])
    const written = [
      { seq: 0, type: "cos.context", payload: contextOf(turn) },
      { seq: 1, type: "cos.message", payload: message },
      { seq: 2, type: "cos.message", payload: reply },
      { seq: 3, type: "cos.tool_result", payload: result },
      { seq: 4, type: "cos.step", payload: logged.payload },
    ]
    const read = await kit.withOrg({ orgId: me.orgId }, (db) =>
      readSession(db, turn.sessionId)
    )
    expect(read.map((e) => [e.seq, e.type])).toEqual(
      written.map((e) => [e.seq, e.type])
    )
    expect(await sha256(deriveCosMessages(read, CONTEXT_POLICY))).toBe(
      await sha256(deriveCosMessages(written, CONTEXT_POLICY))
    )
  })
})
