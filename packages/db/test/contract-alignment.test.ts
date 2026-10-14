import {
  ApprovalDecision,
  Assignment,
  AssignmentState,
  Conversation,
  EventEnvelope,
  FactProvenance,
  FactRecord,
  Org,
  Reminder,
  SiteRevision,
  StaffMember,
  TaintLabel,
} from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import {
  toAssignment,
  toEventEnvelope,
  toFactRecord,
  toOrg,
  toSiteRevision,
  toStaffMember,
} from "../src/map.ts"
import type {
  assignments,
  events,
  facts,
  orgs,
  siteRevisions,
  staff,
} from "../src/schema.ts"
import {
  approvalDecision,
  assignmentPriority,
  assignmentState,
  conversationKind,
  factSource,
  reminderSource,
  siteRevisionStatus,
  staffKind,
  staffStatus,
  taintLabel,
} from "../src/schema.ts"

/**
 * The schema and the contracts describe the same two things. Nothing stops
 * them drifting except this file, so it checks both halves: the enum values
 * are the same set, and a row maps to something the contract accepts.
 */

const now = new Date("2026-08-27T09:30:00.000Z")

describe("enums match the contract", () => {
  it("approval decisions", () => {
    expect(approvalDecision.enumValues).toEqual(
      ApprovalDecision.shape.decision.options
    )
  })

  it("fact provenance sources", () => {
    expect(factSource.enumValues).toEqual(FactProvenance.shape.source.options)
  })

  it("taint labels", () => {
    expect(taintLabel.enumValues).toEqual(TaintLabel.options)
  })

  it("staff kinds", () => {
    expect(staffKind.enumValues).toEqual(StaffMember.shape.kind.options)
  })

  it("staff lifecycle states", () => {
    expect(staffStatus.enumValues).toEqual(StaffMember.shape.status.options)
  })

  it("assignment states", () => {
    expect(assignmentState.enumValues).toEqual(AssignmentState.options)
  })

  it("assignment priorities", () => {
    expect(assignmentPriority.enumValues).toEqual(
      Assignment.shape.priority.options
    )
  })

  it("site revision statuses", () => {
    expect(siteRevisionStatus.enumValues).toEqual(
      SiteRevision.shape.status.options
    )
  })

  it("conversation kinds", () => {
    expect(conversationKind.enumValues).toEqual(Conversation.shape.kind.options)
  })

  it("reminder sources", () => {
    expect(reminderSource.enumValues).toEqual(Reminder.shape.source.options)
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

  const orgRow: typeof orgs.$inferSelect = {
    id: "0198f2d6-1f2b-7a4a-9c6e-2f3b4c5d6e71",
    slug: "brightclean",
    name: "Brightclean Cleaning Co. (fixture)",
    workosOrganizationId: "org_fixture_brightclean",
    createdAt: now,
    updatedAt: now,
  }

  const staffRow: typeof staff.$inferSelect = {
    id: "0198f2d6-1f2b-7a4a-9c6e-2f3b4c5d6e72",
    orgId: orgRow.id,
    staffCode: "COS-001",
    displayName: "Remy",
    kind: "agent",
    userId: null,
    roleId: "0198f2d6-1f2b-7a4a-9c6e-2f3b4c5d6e74",
    departmentId: "0198f2d6-1f2b-7a4a-9c6e-2f3b4c5d6e75",
    managerId: null,
    positionTitle: "Chief of Staff",
    status: "active",
    createdAt: now,
    updatedAt: now,
  }

  const assignmentRow: typeof assignments.$inferSelect = {
    id: "0198f2d6-1f2b-7a4a-9c6e-2f3b4c5d6e76",
    orgId: orgRow.id,
    staffId: staffRow.id,
    createdByStaffId: staffRow.id,
    parentAssignmentId: null,
    revisionOfAssignmentId: null,
    kind: "site.build",
    state: "queued",
    version: 0,
    goal: "Build the first site revision from the canonical fact snapshot.",
    acceptanceCriteria: ["Every price on the page matches a canonical fact"],
    factSnapshotId: "0198f2d6-1f2b-7a4a-9c6e-2f3b4c5d6e77",
    packRefs: [{ key: "cleaning", version: "0.1.0" }],
    budgetUsd: 12.5,
    costUsd: null,
    blueprint: null,
    deadline: null,
    priority: "normal",
    workflowInstanceId: null,
    idempotencyKey: "01K3ZPQRSTVWXYZ01234567892",
    createdAt: now,
    updatedAt: now,
  }

  const revisionRow: typeof siteRevisions.$inferSelect = {
    id: "0198f2d6-1f2b-7a4a-9c6e-2f3b4c5d6e78",
    orgId: orgRow.id,
    siteId: orgRow.id,
    assignmentId: assignmentRow.id,
    version: 1,
    summary: null,
    sourceKey: "sites/x/y/source.tar.zst",
    artifactPrefix: "sites/x/y/dist/",
    manifestKey: "sites/x/y/manifest.json",
    status: "preview",
    retireAfter: null,
    createdAt: now,
    updatedAt: now,
  }

  it("an assignments row is an Assignment, with version as the lock", () => {
    const parsed = Assignment.parse(toAssignment(assignmentRow))
    expect(parsed.expected_version).toBe(0)
  })

  it("the workflow instance and idempotency key stay behind", () => {
    const keys = Object.keys(toAssignment(assignmentRow))
    expect(keys).not.toContain("workflow_instance_id")
    expect(keys).not.toContain("idempotency_key")
  })

  it("a site_revisions row is a SiteRevision", () => {
    expect(() => SiteRevision.parse(toSiteRevision(revisionRow))).not.toThrow()
  })

  it("an orgs row is an Org", () => {
    expect(() => Org.parse(toOrg(orgRow))).not.toThrow()
  })

  it("the WorkOS organization id does not leave with it", () => {
    // `Org` is a strict object, so a mapper that passed the column through
    // would fail to parse rather than leak quietly. This says the same thing
    // where someone reading the mapper will look.
    expect(Object.keys(toOrg(orgRow))).not.toContain("workos_organization_id")
  })

  it("a staff row is a StaffMember", () => {
    expect(() => StaffMember.parse(toStaffMember(staffRow))).not.toThrow()
  })

  it("the org root reports to nobody", () => {
    expect(
      StaffMember.parse(toStaffMember(staffRow)).manager_staff_id
    ).toBeNull()
  })

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
