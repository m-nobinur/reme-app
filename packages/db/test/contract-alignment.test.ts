import {
  EventEnvelope,
  FactProvenance,
  FactRecord,
  TaintLabel,
} from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import { toEventEnvelope, toFactRecord } from "../src/map.ts"
import type { events, facts } from "../src/schema.ts"
import { factSource, taintLabel } from "../src/schema.ts"

/**
 * The schema and the contracts describe the same two things. Nothing stops
 * them drifting except this file, so it checks both halves: the enum values
 * are the same set, and a row maps to something the contract accepts.
 */

const now = new Date("2026-08-27T09:30:00.000Z")

describe("enums match the contract", () => {
  it("fact provenance sources", () => {
    expect(factSource.enumValues).toEqual(FactProvenance.shape.source.options)
  })

  it("taint labels", () => {
    expect(taintLabel.enumValues).toEqual(TaintLabel.options)
  })
})

describe("rows map onto contracts", () => {
  const factRow: typeof facts.$inferSelect = {
    id: "0198f2d6-1f2b-7a4a-9c6e-2f3b4c5d6e70",
    orgId: "0198f2d6-1f2b-7a4a-9c6e-2f3b4c5d6e71",
    key: "hours.tuesday_close",
    factType: "hours",
    value: { time: "18:00" },
    version: 1,
    provenanceSource: "owner_stated",
    provenanceConfidence: 1,
    verifiedByStaffId: "0198f2d6-1f2b-7a4a-9c6e-2f3b4c5d6e72",
    verifiedAt: now,
    validFrom: now,
    validTo: null,
    supersededByFactId: null,
    createdAt: now,
    updatedAt: now,
  }

  const eventRow: typeof events.$inferSelect = {
    eventId: "01K3ZPQRSTVWXYZ01234567890",
    orgId: "0198f2d6-1f2b-7a4a-9c6e-2f3b4c5d6e71",
    staffId: null,
    assignmentId: null,
    // A session, because `seq` is the position in one and the contract pairs
    // the two (ADR-028). The other half of the pair is the case below.
    sessionId: "0198f2d6-1f2b-7a4a-9c6e-2f3b4c5d6e73",
    seq: 0,
    type: "staff.hired",
    occurredAt: now,
    recordedAt: now,
    idempotencyKey: "01K3ZPQRSTVWXYZ01234567891",
    taint: [],
    payload: {},
  }

  it("a facts row is a FactRecord", () => {
    expect(() => FactRecord.parse(toFactRecord(factRow))).not.toThrow()
  })

  it("nullable provenance survives the round trip", () => {
    const parsed = FactRecord.parse(
      toFactRecord({ ...factRow, verifiedByStaffId: null, verifiedAt: null })
    )
    expect(parsed.provenance.verified_at).toBeNull()
  })

  it("an events row is an EventEnvelope", () => {
    expect(() => EventEnvelope.parse(toEventEnvelope(eventRow))).not.toThrow()
  })

  it("an event outside a session carries no seq", () => {
    const parsed = EventEnvelope.parse(
      toEventEnvelope({ ...eventRow, sessionId: null, seq: null })
    )
    expect(parsed.seq).toBeNull()
  })

  it("refuses a row that numbers a stream it is not in", () => {
    // The column is nullable and the check constraint pairs it in the
    // database. This is the same rule on the way out, so a row written before
    // the constraint existed cannot leave as a contract-shaped event.
    expect(() =>
      EventEnvelope.parse(toEventEnvelope({ ...eventRow, sessionId: null }))
    ).toThrow()
  })
})
