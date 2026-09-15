import type { EventEnvelope } from "@workspace/contracts"
import {
  assignments,
  eq,
  events,
  facts,
  sql,
  supersedeFact,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import { verifySpec } from "@workspace/facade"
import { ulid } from "ulid"
import { afterAll, describe, expect, it, vi } from "vitest"
import {
  followUpGoal,
  GOAL_MAX,
  issueSpec,
  takeSnapshot,
  updateFacts,
} from "../src/brief.ts"
import { eventSink, SeqGapError } from "../src/sink.ts"
import { appendEvent } from "../src/state.ts"
import { freshOrg, newAssignment } from "./fixture.ts"

// The brief names the registry host the sandbox module owns, and that module
// loads the container SDK, which only resolves under workerd. Hoisted above
// the imports by vitest.
vi.mock("../src/sandbox.ts", () => ({
  NPM_REGISTRY_HOST: "registry.npmjs.org",
}))

/**
 * What the Developer is handed and what it writes back, against a real
 * database: the versioning rule for facts, the snapshot that withholds, the
 * spec that is signed and logged without its signature, and the sink that
 * refuses a gap in a session's stream.
 */
const url = process.env.DATABASE_URL
const live = describe.skipIf(!url)

const kit: Tenancy = tenancy(url ?? "postgres://unused")
afterAll(() => kit.close())

const KEY = "runtime-spec-key-for-this-suite-only"

const phone = (orgId: string, value: string) =>
  kit.withOrg({ orgId }, (db) =>
    supersedeFact(db, {
      orgId,
      key: "business.phone",
      factType: "business",
      value,
      provenance: { source: "owner_stated", confidence: 1 },
    })
  )

const currentFacts = (orgId: string) =>
  kit.withOrg({ orgId }, (db) =>
    db.select().from(facts).where(sql`${facts.validTo} is null`)
  )

live("supersedeFact", () => {
  it("opens version 1 when the key is new", async () => {
    const orgId = await freshOrg(kit)
    const first = await phone(orgId, "020 7946 0000")
    expect(first.version).toBe(1)
    expect(first.supersededFactId).toBeNull()
  })

  it("closes the current row, opens version + 1, and links them", async () => {
    const orgId = await freshOrg(kit)
    const first = await phone(orgId, "020 7946 0000")
    const second = await phone(orgId, "020 7946 0001")
    expect(second.version).toBe(2)
    expect(second.supersededFactId).toBe(first.factId)

    const rows = await kit.withOrg({ orgId }, (db) =>
      db.select().from(facts).orderBy(facts.version)
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]?.validTo).not.toBeNull()
    expect(rows[0]?.supersededByFactId).toBe(second.factId)
    expect(rows[1]?.validTo).toBeNull()
    expect(await currentFacts(orgId)).toHaveLength(1)
  })
})

live("takeSnapshot", () => {
  it("freezes the current facts, minus the withheld keys, as one event", async () => {
    const orgId = await freshOrg(kit)
    await phone(orgId, "020 7946 0000")
    await kit.withOrg({ orgId }, (db) =>
      supersedeFact(db, {
        orgId,
        key: "business.name",
        factType: "business",
        value: "BrightClean",
        provenance: { source: "owner_stated", confidence: 1 },
      })
    )
    const ids = await newAssignment(kit, orgId)
    const snapshot = await kit.withOrg({ orgId }, (db) =>
      takeSnapshot(db, ids, ["business.phone"])
    )
    expect(snapshot.facts.map((f) => f.key)).toEqual(["business.name"])

    const [row] = await kit.withOrg({ orgId }, (db) =>
      db.select().from(assignments).where(eq(assignments.id, ids.assignmentId))
    )
    expect(row?.factSnapshotId).toBe(snapshot.snapshot_id)

    const taken = await kit.withOrg({ orgId }, (db) =>
      db
        .select()
        .from(events)
        .where(
          sql`${events.assignmentId} = ${ids.assignmentId} and ${events.type} = 'facts.snapshot_taken'`
        )
    )
    expect(taken).toHaveLength(1)
    expect(taken[0]?.payload).toMatchObject({
      snapshot_id: snapshot.snapshot_id,
      withheld: ["business.phone"],
    })
  })
})

live("issueSpec", () => {
  it("signs a spec capped at the owner's ceiling and logs it unsigned", async () => {
    const orgId = await freshOrg(kit)
    const ids = await newAssignment(kit, orgId)
    const spec = await kit.withOrg({ orgId }, async (db) => {
      const [row] = await db
        .select()
        .from(assignments)
        .where(eq(assignments.id, ids.assignmentId))
      if (!row) throw new Error("no row")
      return issueSpec(
        db,
        { RUNTIME_SPEC_KEY: KEY, REME_MODEL_DEFAULT: "openai/gpt-5-mini" },
        { ...row, budgetUsd: 50 },
        "A"
      )
    })
    expect(spec.budget_snapshot.model_usd_cap).toBe(1)
    expect(verifySpec(spec, KEY).spec_id).toBe(spec.spec_id)

    const [logged] = await kit.withOrg({ orgId }, (db) =>
      db
        .select()
        .from(events)
        .where(
          sql`${events.assignmentId} = ${ids.assignmentId} and ${events.type} = 'runtime.spec_issued'`
        )
    )
    expect(logged?.payload.spec_id).toBe(spec.spec_id)
    expect(logged?.payload).not.toHaveProperty("signature")
  })
})

live("eventSink", () => {
  const envelope = (
    ids: { orgId: string; assignmentId: string },
    sessionId: string,
    seq: number
  ): EventEnvelope => ({
    event_id: ulid(),
    org_id: ids.orgId,
    staff_id: null,
    assignment_id: ids.assignmentId,
    session_id: sessionId,
    seq,
    type: "probe.noted",
    occurred_at: new Date().toISOString(),
    idempotency_key: ulid(),
    taint: [],
    payload: {},
  })

  it("appends a contiguous batch and refuses a gap", async () => {
    const orgId = await freshOrg(kit)
    const ids = await newAssignment(kit, orgId)
    const sink = eventSink(kit, orgId)
    const session = crypto.randomUUID()
    expect(await sink.lastSeq(session)).toBeNull()

    await sink.append([envelope(ids, session, 0), envelope(ids, session, 1)])
    expect(await sink.lastSeq(session)).toBe(1)

    await expect(sink.append([envelope(ids, session, 3)])).rejects.toThrow(
      SeqGapError
    )
    expect(await sink.lastSeq(session)).toBe(1)

    await sink.append([envelope(ids, session, 2)])
    expect(await sink.lastSeq(session)).toBe(2)
  })

  it("leaves an unsequenced audit row outside the stream", async () => {
    const orgId = await freshOrg(kit)
    const ids = await newAssignment(kit, orgId)
    await kit.withOrg({ orgId }, (db) =>
      appendEvent(db, {
        orgId,
        assignmentId: ids.assignmentId,
        staffId: null,
        type: "probe.noted",
        payload: {},
      })
    )
    const sink = eventSink(kit, orgId)
    expect(await sink.lastSeq(crypto.randomUUID())).toBeNull()
  })
})

describe("followUpGoal", () => {
  it("adds the follow-up under the goal it continues", () => {
    expect(followUpGoal("Build the site.", "Make the hero calmer")).toBe(
      "Build the site.\n\nFollow-up: Make the hero calmer"
    )
  })

  it("refuses a result past the cap instead of cutting it", () => {
    expect(followUpGoal("x".repeat(GOAL_MAX - 12), "y")).toBeNull()
  })
})

live("updateFacts", () => {
  const edit = (
    orgId: string,
    idempotencyKey: string,
    changes: { key: string; value: unknown }[]
  ) =>
    kit.withOrg({ orgId }, (db) =>
      updateFacts(db, { orgId, idempotencyKey, changes })
    )

  const updates = (orgId: string) =>
    kit.withOrg({ orgId }, (db) =>
      db.select().from(events).where(sql`${events.type} = 'facts.updated'`)
    )

  it("opens an owner-stated version with the current row's type, logged once", async () => {
    const orgId = await freshOrg(kit)
    await phone(orgId, "020 7946 0000")
    const result = await edit(orgId, "edit-1", [
      { key: "business.phone", value: "020 7946 0009" },
    ])
    expect(result).toMatchObject({ outcome: "written", replayed: false })

    const [row] = await currentFacts(orgId)
    expect(row).toMatchObject({
      value: "020 7946 0009",
      version: 2,
      factType: "business",
      provenanceSource: "owner_stated",
    })
    expect(row?.verifiedByStaffId).not.toBeNull()
    const logged = await updates(orgId)
    expect(logged).toHaveLength(1)
    expect(logged[0]?.payload).toMatchObject({
      idempotency_key: "edit-1",
      facts: [{ key: "business.phone", fact_id: row?.id, version: 2 }],
    })
  })

  it("replays the same idempotency key without writing again", async () => {
    const orgId = await freshOrg(kit)
    await phone(orgId, "020 7946 0000")
    const change = [{ key: "business.phone", value: "020 7946 0009" }]
    await edit(orgId, "edit-2", change)
    const again = await edit(orgId, "edit-2", change)
    expect(again).toMatchObject({ outcome: "written", replayed: true })
    expect((await currentFacts(orgId))[0]?.version).toBe(2)
    expect(await updates(orgId)).toHaveLength(1)
  })

  it("refuses a key with no current fact and writes nothing from the batch", async () => {
    const orgId = await freshOrg(kit)
    await phone(orgId, "020 7946 0000")
    const result = await edit(orgId, "edit-3", [
      { key: "business.phone", value: "020 7946 0009" },
      { key: "pricing.invented", value: "$1" },
    ])
    expect(result).toEqual({ outcome: "unknown_key", key: "pricing.invented" })
    expect((await currentFacts(orgId))[0]?.version).toBe(1)
    expect(await updates(orgId)).toHaveLength(0)
  })

  it("refuses a value whose shape differs from the current one", async () => {
    const orgId = await freshOrg(kit)
    await kit.withOrg({ orgId }, (db) =>
      supersedeFact(db, {
        orgId,
        key: "hours.weekday",
        factType: "hours",
        value: { open: "08:00", close: "17:00" },
        provenance: { source: "owner_stated", confidence: 1 },
      })
    )
    for (const value of ["08:00 to 18:00", { open: "08:00", shut: "18:00" }]) {
      expect(
        await edit(orgId, `edit-4-${typeof value}`, [
          { key: "hours.weekday", value },
        ])
      ).toEqual({ outcome: "shape_changed", key: "hours.weekday" })
    }
    expect(
      await edit(orgId, "edit-4-ok", [
        { key: "hours.weekday", value: { open: "08:00", close: "18:00" } },
      ])
    ).toMatchObject({ outcome: "written" })
  })

  it("cannot reach another org's facts", async () => {
    const holder = await freshOrg(kit)
    await phone(holder, "020 7946 0000")
    const other = await freshOrg(kit)
    expect(
      await edit(other, "edit-5", [
        { key: "business.phone", value: "020 7946 0009" },
      ])
    ).toEqual({ outcome: "unknown_key", key: "business.phone" })
    expect((await currentFacts(holder))[0]?.version).toBe(1)
  })
})
