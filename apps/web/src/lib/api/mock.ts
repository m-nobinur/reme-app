import { GOLDEN_ORGS } from "@workspace/db/fixtures"
import { formatMoney } from "@workspace/ui/lib/format"
import type {
  ActivityItem,
  ApprovalItem,
  AttentionItem,
  Json,
  OrgNode,
  OrgSummary,
  OwnerDataSource,
  PipelineItem,
  StaffMember,
  TransportedFact,
} from "./types"

/**
 * The fixture-backed data source. Every business fact on every screen comes
 * from `@workspace/db/fixtures`: the same `brightclean`, `mopandbucket` and
 * `emptyco` rows the seed writes and the suites read, so nobody hand-crafts a
 * second copy of the same business. That import is a type-only data module, so
 * no drizzle and no connection reach this Worker.
 *
 * Two kinds of row have no fixture home yet, because they have no table: the
 * owner-attention items (§7.3) and the pipeline (§4). They are built here, from
 * fixture staff ids and fixture facts, so an approval names a real fixture
 * staff member and a price on this screen is a price in the fixture set. When
 * B2's schema grows those tables, these move into the golden module and this
 * file loses them.
 *
 * Timestamps are fixed rather than relative to now. A fixture that moves with
 * the clock is not a fixture: the screens render absolute dates so two runs of
 * the same suite compare the same data.
 */

const ORGS = GOLDEN_ORGS

/** Ids for rows that exist only here. `1000000x` is taken by the fixtures. */
const mockId = (which: 1 | 2, n: number) =>
  `2000000${which}-0000-4000-8000-${String(n).padStart(12, "0")}`

type Golden = (typeof ORGS)[number]

function org(orgId: string): Golden {
  const found = ORGS.find((candidate) => candidate.org.id === orgId)
  if (!found) {
    throw new Error(`No fixture organisation with id ${orgId}`)
  }
  return found
}

function summary(fixture: Golden): OrgSummary {
  return {
    id: String(fixture.org.id),
    slug: fixture.slug,
    name: String(fixture.org.name),
  }
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null
  }
  return typeof value === "string" ? value : value.toISOString()
}

function staffOf(fixture: Golden): StaffMember[] {
  const roles = new Map(fixture.roles.map((role) => [role.id, role.title]))
  const departments = new Map(
    fixture.departments.map((department) => [department.id, department.name])
  )
  return fixture.staff.map((row) => ({
    id: String(row.id),
    staffCode: row.staffCode,
    displayName: row.displayName,
    kind: row.kind as "agent" | "human",
    positionTitle: row.positionTitle ?? null,
    roleTitle: (row.roleId ? roles.get(row.roleId) : null) ?? null,
    departmentName:
      (row.departmentId ? departments.get(row.departmentId) : null) ?? null,
    managerId: row.managerId ?? null,
    // `staff.status` carries a database default, so the insert type makes it
    // optional. Absent means the default, not "assume active".
    status: row.status ?? "draft",
  }))
}

/**
 * The `manager_id` closure (§5.2). Built in one pass over the rows rather than
 * by repeated filtering, and roots are the rows whose manager is absent from
 * this org, so an orphan is still rendered rather than silently dropped.
 */
function treeOf(members: StaffMember[]): OrgNode[] {
  const nodes = new Map<string, OrgNode>(
    members.map((staff) => [staff.id, { staff, reports: [] }])
  )
  const roots: OrgNode[] = []
  for (const node of nodes.values()) {
    const parent = node.staff.managerId
      ? nodes.get(node.staff.managerId)
      : undefined
    if (parent) {
      parent.reports.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}

function factsOf(fixture: Golden): TransportedFact[] {
  return fixture.facts.map((row) => ({
    fact_id: String(row.id),
    org_id: String(row.orgId),
    key: row.key,
    fact_type: row.factType,
    value: row.value as Json,
    version: row.version ?? 1,
    provenance: {
      source: row.provenanceSource as TransportedFact["provenance"]["source"],
      confidence: Number(row.provenanceConfidence ?? 1),
      verified_by_staff_id: row.verifiedByStaffId ?? null,
      verified_at: iso(row.verifiedAt),
    },
    valid_from: iso(row.validFrom) ?? "",
    valid_to: iso(row.validTo),
    superseded_by_fact_id: row.supersededByFactId ?? null,
  }))
}

// ---------------------------------------------------------------------------
// Rows with no table yet: attention and pipeline
// ---------------------------------------------------------------------------

const BC = ORGS[0]
const MB = ORGS[1]

/** Named fixture staff, so nothing below invents a person. */
const bcStaff = (code: string) => {
  const row = BC.staff.find((member) => member.staffCode === code)
  if (!row) {
    throw new Error(`No fixture staff ${code} in brightclean`)
  }
  return row
}

const BC_OWNER = bcStaff("OWN-001")
const BC_COS = bcStaff("COS-001")
const BC_DEV = bcStaff("DEV-001")
const BC_GROWTH = bcStaff("GRO-001")
const BC_CLIENT = bcStaff("CSS-001")
const BC_BOOKING = bcStaff("BKG-001")

/**
 * The current standard-clean price, read from the fact rather than retyped. A
 * missing fact fails loudly here rather than rendering a price of `undefined`
 * on an approval: a wrong number on this screen is the failure R8 is about.
 */
const BC_PRICE = BC.facts.find(
  (fact) => fact.key === "pricing.standard_clean_hourly" && fact.version === 2
)
if (!BC_PRICE) {
  throw new Error("brightclean has no current standard-clean price fact")
}
const BC_PRICE_MINOR = (BC_PRICE.value as { amount_minor: number }).amount_minor

const approvals: Record<string, ApprovalItem[]> = {
  [String(BC.org.id)]: [
    {
      request: {
        approval_id: mockId(1, 1),
        org_id: String(BC.org.id),
        assignment_id: mockId(1, 101),
        requested_by_staff_id: String(BC_DEV.id),
        approver_staff_id: String(BC_OWNER.id),
        action_kind: "publish_revision",
        target: { kind: "revision", revision_id: mockId(1, 201) },
        rationale:
          "The homepage draft is built from the current facts and passed the content gate. Nothing publishes until you say so.",
        requested_at: "2026-08-24T09:12:00.000Z",
        expires_at: "2026-08-31T09:12:00.000Z",
      },
      title: "Publish the new homepage",
      requestedBy: BC_DEV.displayName,
      onExpiry:
        "The revision stays unpublished and Alex raises it again with the next build.",
    },
    {
      request: {
        approval_id: mockId(1, 2),
        org_id: String(BC.org.id),
        assignment_id: null,
        requested_by_staff_id: String(BC_GROWTH.id),
        approver_staff_id: String(BC_OWNER.id),
        action_kind: "connect_domain",
        target: { kind: "domain", hostname: "brightclean.invalid" },
        rationale:
          "Pointing the site at your own domain changes where customers land. Tier 3, so it stays with you.",
        requested_at: "2026-08-25T14:40:00.000Z",
        expires_at: "2026-09-08T14:40:00.000Z",
      },
      title: "Connect your own domain",
      requestedBy: BC_GROWTH.displayName,
      onExpiry: "The request lapses and the site stays on its current address.",
    },
    {
      request: {
        approval_id: mockId(1, 3),
        org_id: String(BC.org.id),
        assignment_id: null,
        requested_by_staff_id: String(BC_CLIENT.id),
        approver_staff_id: String(BC_OWNER.id),
        action_kind: "issue_refund",
        target: { kind: "spend", amount_usd: 84, currency: "USD" },
        rationale:
          "A customer asked for a partial refund on a clean that overran. Money is tier 3 and never automatic.",
        requested_at: "2026-08-26T08:05:00.000Z",
        expires_at: "2026-08-29T08:05:00.000Z",
      },
      title: "Refund part of a clean that overran",
      requestedBy: BC_CLIENT.displayName,
      onExpiry:
        "Nothing is refunded. Jamie replies to say the request is still with you.",
    },
    {
      request: {
        approval_id: mockId(1, 4),
        org_id: String(BC.org.id),
        assignment_id: null,
        requested_by_staff_id: String(BC_GROWTH.id),
        approver_staff_id: String(BC_OWNER.id),
        action_kind: "publish_claim",
        target: {
          kind: "sensitive_claim",
          fact_id: String(BC_PRICE?.id ?? ""),
          claim: `Standard clean, ${formatMoney(BC_PRICE_MINOR, "USD")} an hour`,
        },
        rationale:
          "Putting a price on the site is a public commitment, so it is bound to the fact it came from.",
        requested_at: "2026-08-26T11:20:00.000Z",
        expires_at: "2026-09-02T11:20:00.000Z",
      },
      title: "Put your standard rate on the website",
      requestedBy: BC_GROWTH.displayName,
      onExpiry: "The page ships without a price rather than with a guess.",
    },
  ],
  [String(MB.org.id)]: [],
}

/** §7.3: Question, ApprovalRequest, Report and Alert. There is no fifth. */
const attention: Record<string, AttentionItem[]> = {
  [String(BC.org.id)]: [
    {
      kind: "question",
      id: mockId(1, 10),
      title: "Do you cover Saturday mornings?",
      detail:
        "Two enquiries this week asked. Your hours fact covers weekdays only, so I have not answered either way.",
      raisedBy: BC_COS.displayName,
      raisedAt: "2026-08-26T07:30:00.000Z",
      expiresAt: "2026-08-30T07:30:00.000Z",
      onExpiry:
        "I tell both customers weekday hours only and leave the fact unchanged.",
    },
    // The approvals inbox and the dashboard show the same rows, not two
    // copies of them: an approval the owner answers on one screen is gone from
    // the other.
    ...(approvals[String(BC.org.id)] ?? []).slice(0, 2).map(
      (item): AttentionItem => ({
        kind: "approval",
        id: item.request.approval_id,
        title: item.title,
        detail: item.request.rationale,
        raisedBy: item.requestedBy,
        raisedAt: item.request.requested_at,
        expiresAt: item.request.expires_at,
        onExpiry: item.onExpiry,
        request: item.request,
      })
    ),
    {
      kind: "report",
      id: mockId(1, 12),
      title: "Six enquiries answered this week",
      detail:
        "Every enquiry got a first reply inside four minutes. Two are waiting on a quote from you.",
      raisedBy: BC_COS.displayName,
      raisedAt: "2026-08-25T17:00:00.000Z",
      expiresAt: null,
      onExpiry: "Nothing. A report is there to read, not to answer.",
    },
    {
      kind: "alert",
      id: mockId(1, 13),
      title: "A quote has been unanswered for nine days",
      detail:
        "I have chased twice. A third chase reads as pressure, so this is with you.",
      raisedBy: BC_CLIENT.displayName,
      raisedAt: "2026-08-26T06:00:00.000Z",
      expiresAt: "2026-09-01T06:00:00.000Z",
      onExpiry: "I close the quote as lapsed and stop chasing.",
    },
  ],
  [String(MB.org.id)]: [
    {
      kind: "report",
      id: mockId(2, 10),
      title: "Robin finished setting up your service area",
      detail: "One enquiry arrived since. It is in the pipeline.",
      raisedBy: "Robin",
      raisedAt: "2026-08-25T10:00:00.000Z",
      expiresAt: null,
      onExpiry: "Nothing. A report is there to read, not to answer.",
    },
  ],
}

const pipeline: Record<string, PipelineItem[]> = {
  [String(BC.org.id)]: [
    {
      id: mockId(1, 20),
      customer: "Fixture Customer 1",
      channel: "Website form",
      stage: "new",
      summary: "Three-bedroom house, weekly, wants a start date next month.",
      nextAction: "Answer the enquiry and ask the qualifying questions",
      ownerStaffName: BC_BOOKING.displayName,
      followUpAt: "2026-08-27T09:00:00.000Z",
      receivedAt: "2026-08-26T18:42:00.000Z",
    },
    {
      id: mockId(1, 21),
      customer: "Fixture Customer 2",
      channel: "Email",
      stage: "qualifying",
      summary: "Office, twice weekly, asked whether evenings are possible.",
      nextAction: "Confirm the hours before quoting",
      ownerStaffName: BC_CLIENT.displayName,
      followUpAt: "2026-08-28T09:00:00.000Z",
      receivedAt: "2026-08-24T11:05:00.000Z",
    },
    {
      id: mockId(1, 22),
      customer: "Fixture Customer 3",
      channel: "Website chat",
      stage: "quoted",
      summary: `Four hours a week at ${formatMoney(BC_PRICE_MINOR, "USD")} an hour.`,
      nextAction: "Chase the quote a second time",
      ownerStaffName: BC_CLIENT.displayName,
      followUpAt: "2026-08-29T09:00:00.000Z",
      receivedAt: "2026-08-17T09:15:00.000Z",
    },
    {
      id: mockId(1, 23),
      customer: "Fixture Customer 4",
      channel: "Website form",
      stage: "booked",
      summary: "First clean booked, deposit paid.",
      nextAction: "Send the reminder the day before",
      ownerStaffName: BC_BOOKING.displayName,
      followUpAt: "2026-09-01T08:00:00.000Z",
      receivedAt: "2026-08-12T14:20:00.000Z",
    },
    {
      id: mockId(1, 24),
      customer: "Fixture Customer 5",
      channel: "Email",
      stage: "completed",
      summary: "Deep clean delivered, review requested.",
      nextAction: "Nothing until the review lands",
      ownerStaffName: BC_CLIENT.displayName,
      followUpAt: null,
      receivedAt: "2026-08-04T10:00:00.000Z",
    },
  ],
  [String(MB.org.id)]: [
    {
      id: mockId(2, 20),
      customer: "Fixture Customer 6",
      channel: "Website form",
      stage: "new",
      summary: "Two-bedroom flat, end of tenancy.",
      nextAction: "Answer the enquiry",
      ownerStaffName: "Robin",
      followUpAt: "2026-08-27T09:00:00.000Z",
      receivedAt: "2026-08-26T20:10:00.000Z",
    },
  ],
}

/**
 * The dashboard's activity strip, read from the fixture event log rather than
 * written here: §10.6 makes that log the system of record for what happened.
 */
function activityOf(fixture: Golden): ActivityItem[] {
  const names = new Map(
    fixture.staff.map((row) => [row.id, row.displayName] as const)
  )
  const titles = new Map(
    fixture.staff.map((row) => [row.id, row.positionTitle ?? row.staffCode])
  )
  return fixture.events.map((event) => ({
    id: String(event.eventId),
    summary:
      event.type === "staff.hired"
        ? `Hired ${names.get(String(event.staffId)) ?? "a staff member"} as ${titles.get(String(event.staffId)) ?? "staff"}`
        : event.type,
    occurredAt: iso(event.occurredAt) ?? "",
  }))
}

/**
 * Approvals the owner has answered in this isolate. A Worker isolate is not
 * storage: this survives a click and not a redeploy, which is the right amount
 * of memory for a mock and is why nothing here pretends to be a decision log.
 * The real one is an event-log append (§10.6) behind B5.
 */
const decided = new Set<string>()

export const mockSource: OwnerDataSource = {
  orgs: async () => ORGS.map(summary),
  staff: async (orgId) => staffOf(org(orgId)),
  orgTree: async (orgId) => treeOf(staffOf(org(orgId))),
  attention: async (orgId) =>
    (attention[orgId] ?? []).filter((item) => !decided.has(item.id)),
  approvals: async (orgId) =>
    (approvals[orgId] ?? []).filter(
      (item) => !decided.has(item.request.approval_id)
    ),
  pipeline: async (orgId) => pipeline[orgId] ?? [],
  profile: async (orgId) => {
    const fixture = org(orgId)
    return { org: summary(fixture), facts: factsOf(fixture) }
  },
  activity: async (orgId) => activityOf(org(orgId)),
  decideApproval: async (orgId, approvalId) => {
    // Only an approval this organisation actually holds can be decided, so a
    // hand-typed id from another tenant answers nothing.
    const held = (approvals[orgId] ?? []).some(
      (item) => item.request.approval_id === approvalId
    )
    if (held) {
      decided.add(approvalId)
    }
  },
}
