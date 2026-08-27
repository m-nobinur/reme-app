import type {
  departments,
  events,
  facts,
  orgs,
  roles,
  staff,
  staffEvents,
  users,
} from "../src/schema.ts"

/**
 * The golden orgs: `brightclean`, `mopandbucket` and `emptyco`. One set of rows
 * shared by the seed, the suites, the mock UI and the evals, so nobody writes a
 * second copy of the same business.
 *
 * Data only. Every import here is `import type`, so this module has no runtime
 * dependency on drizzle or on a connection and can be imported from a Worker
 * bundle as plain objects. The writer is `fixtures/seed.ts`.
 *
 * Three orgs because three states need to be renderable:
 *
 * - `brightclean` is fully configured. Its staff tree is the one in §5.2, so
 *   the org-tree screen has something with real depth to draw, and it carries a
 *   row in every table the schema has.
 * - `mopandbucket` is a smaller second tenant. It exists so a cross-org read is
 *   testable against a neighbour that actually holds rows, and so an org
 *   switcher has two entries.
 * - `emptyco` is an owner who has signed up and configured nothing. Every empty
 *   state in the app is reachable by switching to it.
 *
 * R8: all three are unmistakably fictional and `test/golden-fixtures.test.ts`
 * enforces it rather than trusting this paragraph. Every org name carries
 * `(fixture)`, every address is `.invalid` (reserved by RFC 2606, so it can
 * never resolve), and every phone number is in the North American `555-01xx`
 * block, which is reserved for fiction. Prices, hours and service areas exist
 * only as facts, which is where the content gate will look for them.
 */

type OrgRow = typeof orgs.$inferInsert
type UserRow = typeof users.$inferInsert
type RoleRow = typeof roles.$inferInsert
type DepartmentRow = typeof departments.$inferInsert
type StaffRow = typeof staff.$inferInsert
type FactRow = typeof facts.$inferInsert
type StaffEventRow = typeof staffEvents.$inferInsert
type EventRow = typeof events.$inferInsert

export type GoldenOrg = {
  readonly slug: string
  readonly org: OrgRow
  readonly users: UserRow[]
  readonly roles: RoleRow[]
  readonly departments: DepartmentRow[]
  readonly staff: StaffRow[]
  readonly facts: FactRow[]
  readonly staffEvents: StaffEventRow[]
  readonly events: EventRow[]
}

/**
 * Ids are fixed and readable: the first group names the org, the last numbers
 * the row. A fixture is only useful if a test, a mock handler and a recorded
 * eval can all name the same row, which rules out generating them.
 *
 * The first group also keeps them clear of the ids already in the repo. The
 * tenancy probes and `tenancy/fixtures.ts` all start `00000000`.
 */
const id = (org: 1 | 2 | 3, n: number) =>
  `1000000${org}-0000-4000-8000-${String(n).padStart(12, "0")}`

/**
 * ULIDs for the event log. The check constraint wants 26 characters of
 * Crockford base32 starting `0`-`7`, and Crockford drops I, L, O and U, which
 * is why this does not spell anything more obvious than `SEED`.
 */
const ulid = (tag: "B" | "M", n: number) =>
  `01K4SEED${tag}${String(n).padStart(17, "0")}`

/**
 * One timestamp for every fixture row that carries an explicit one. A fixture
 * that moves with the clock is not a fixture: an eval recorded against it stops
 * replaying, and two runs of the same suite compare different data.
 */
const AT = new Date("2026-01-06T09:00:00.000Z")

// ---------------------------------------------------------------------------
// brightclean
// ---------------------------------------------------------------------------

const bc = (n: number) => id(1, n)

const BC_OWNER_USER = bc(1)
const BC_OPERATIONS = bc(10)
const BC_GROWTH = bc(11)
const BC_CLIENT_SERVICES = bc(12)
const BC_ROOT = bc(30)
const BC_COS = bc(31)
const BC_DEV = bc(32)
const BC_GRO = bc(33)
const BC_CSS = bc(34)
const BC_OPS = bc(35)
const BC_BKG = bc(36)
const BC_QA = bc(37)

/** Every agent hire, in the order it happened. Drives two tables below. */
const brightcleanHires = [BC_COS, BC_DEV, BC_GRO, BC_CSS, BC_OPS, BC_BKG, BC_QA]

export const brightclean: GoldenOrg = {
  slug: "brightclean",
  org: {
    id: bc(0),
    slug: "brightclean",
    name: "Brightclean Cleaning Co. (fixture)",
  },
  users: [
    {
      id: BC_OWNER_USER,
      orgId: bc(0),
      workosUserId: "user_fixture_brightclean_owner",
      email: "dana@brightclean.invalid",
      name: "Dana Reyes",
    },
  ],
  roles: [
    {
      id: bc(20),
      orgId: bc(0),
      key: "chief_of_staff",
      title: "Chief of Staff",
    },
    { id: bc(21), orgId: bc(0), key: "developer", title: "Developer" },
    { id: bc(22), orgId: bc(0), key: "growth", title: "Growth" },
    {
      id: bc(23),
      orgId: bc(0),
      key: "client_services",
      title: "Client Services",
    },
    { id: bc(24), orgId: bc(0), key: "ops_manager", title: "Ops Manager" },
    {
      id: bc(25),
      orgId: bc(0),
      key: "booking_coordinator",
      title: "Booking Coordinator",
    },
    {
      id: bc(26),
      orgId: bc(0),
      key: "qa_coordinator",
      title: "QA Coordinator",
    },
  ],
  departments: [
    { id: BC_OPERATIONS, orgId: bc(0), name: "Operations" },
    { id: BC_GROWTH, orgId: bc(0), name: "Growth" },
    { id: BC_CLIENT_SERVICES, orgId: bc(0), name: "Client Services" },
  ],
  // Root first, then the tree in the order §5.2 draws it. Order matters: a
  // manager has to exist before the row that reports to it.
  staff: [
    {
      id: BC_ROOT,
      orgId: bc(0),
      staffCode: "OWN-001",
      displayName: "Dana Reyes",
      kind: "human",
      userId: BC_OWNER_USER,
      positionTitle: "Owner",
      status: "active",
    },
    {
      id: BC_COS,
      orgId: bc(0),
      staffCode: "COS-001",
      displayName: "Maya",
      kind: "agent",
      roleId: bc(20),
      departmentId: BC_OPERATIONS,
      managerId: BC_ROOT,
      positionTitle: "Chief of Staff",
      status: "active",
    },
    {
      id: BC_DEV,
      orgId: bc(0),
      staffCode: "DEV-001",
      displayName: "Alex",
      kind: "agent",
      roleId: bc(21),
      departmentId: BC_OPERATIONS,
      managerId: BC_COS,
      positionTitle: "Developer",
      status: "active",
    },
    {
      id: BC_GRO,
      orgId: bc(0),
      staffCode: "GRO-001",
      displayName: "Nora",
      kind: "agent",
      roleId: bc(22),
      departmentId: BC_GROWTH,
      managerId: BC_COS,
      positionTitle: "Growth",
      status: "active",
    },
    {
      id: BC_CSS,
      orgId: bc(0),
      staffCode: "CSS-001",
      displayName: "Jamie",
      kind: "agent",
      roleId: bc(23),
      departmentId: BC_CLIENT_SERVICES,
      managerId: BC_COS,
      positionTitle: "Client Services",
      status: "active",
    },
    {
      id: BC_OPS,
      orgId: bc(0),
      staffCode: "OPS-001",
      displayName: "Daniel",
      kind: "agent",
      roleId: bc(24),
      departmentId: BC_OPERATIONS,
      managerId: BC_COS,
      positionTitle: "Ops Manager",
      status: "active",
    },
    {
      id: BC_BKG,
      orgId: bc(0),
      staffCode: "BKG-001",
      displayName: "Priya",
      kind: "agent",
      roleId: bc(25),
      departmentId: BC_OPERATIONS,
      managerId: BC_OPS,
      positionTitle: "Booking Coordinator",
      status: "active",
    },
    {
      id: BC_QA,
      orgId: bc(0),
      staffCode: "QA-001",
      displayName: "Sam",
      kind: "agent",
      roleId: bc(26),
      departmentId: BC_OPERATIONS,
      managerId: BC_OPS,
      // One staff member not in `active`, so a directory that assumes every
      // row is active is wrong against the fixture rather than in production.
      positionTitle: "QA Coordinator",
      status: "paused",
    },
  ],
  // The canonical facts. Anything the site or an owner-facing message claims
  // about this business has to trace back to one of these (R8).
  facts: [
    {
      id: bc(40),
      orgId: bc(0),
      key: "business.phone",
      factType: "contact",
      value: { e164: "+15550142" },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: BC_ROOT,
      verifiedAt: AT,
      validFrom: AT,
    },
    {
      id: bc(41),
      orgId: bc(0),
      key: "business.email",
      factType: "contact",
      value: { address: "hello@brightclean.invalid" },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: BC_ROOT,
      verifiedAt: AT,
      validFrom: AT,
    },
    {
      id: bc(42),
      orgId: bc(0),
      key: "hours.weekday",
      factType: "hours",
      value: { open: "08:00", close: "17:00" },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: BC_ROOT,
      verifiedAt: AT,
      validFrom: AT,
    },
    {
      id: bc(43),
      orgId: bc(0),
      key: "service_area.radius",
      factType: "service_area",
      value: { centre: "Fairhaven", radius_km: 25 },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: BC_ROOT,
      verifiedAt: AT,
      validFrom: AT,
    },
    {
      id: bc(44),
      orgId: bc(0),
      key: "pricing.standard_clean_hourly",
      factType: "pricing",
      value: { amount_minor: 3500, currency: "USD" },
      version: 2,
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: BC_ROOT,
      verifiedAt: AT,
      validFrom: AT,
    },
    // A superseded version, so anything reading facts has to respect
    // `valid_to` rather than assuming one row per key. Version 1 is what the
    // current version 2 above replaced. `facts_version_positive` means a
    // version is never 0.
    {
      id: bc(45),
      orgId: bc(0),
      key: "pricing.standard_clean_hourly",
      factType: "pricing",
      value: { amount_minor: 3200, currency: "USD" },
      version: 1,
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: BC_ROOT,
      verifiedAt: AT,
      validFrom: new Date("2025-06-01T09:00:00.000Z"),
      validTo: AT,
      supersededByFactId: bc(44),
    },
  ],
  staffEvents: brightcleanHires.map((staffId, n) => ({
    id: bc(50 + n),
    orgId: bc(0),
    staffId,
    kind: "hired" as const,
    actorStaffId: BC_ROOT,
    occurredAt: AT,
  })),
  events: brightcleanHires.map((staffId, n) => ({
    eventId: ulid("B", n * 2),
    orgId: bc(0),
    staffId,
    seq: n,
    type: "staff.hired",
    occurredAt: AT,
    idempotencyKey: ulid("B", n * 2 + 1),
  })),
}

// ---------------------------------------------------------------------------
// mopandbucket
// ---------------------------------------------------------------------------

const mb = (n: number) => id(2, n)

const MB_OWNER_USER = mb(1)
const MB_ROOT = mb(30)
const MB_COS = mb(31)

export const mopandbucket: GoldenOrg = {
  slug: "mopandbucket",
  org: {
    id: mb(0),
    slug: "mopandbucket",
    name: "Mop and Bucket Ltd. (fixture)",
  },
  users: [
    {
      id: MB_OWNER_USER,
      orgId: mb(0),
      workosUserId: "user_fixture_mopandbucket_owner",
      email: "kit@mopandbucket.invalid",
      name: "Kit Mbeki",
    },
  ],
  roles: [
    {
      id: mb(20),
      orgId: mb(0),
      key: "chief_of_staff",
      title: "Chief of Staff",
    },
  ],
  departments: [{ id: mb(10), orgId: mb(0), name: "Operations" }],
  staff: [
    {
      id: MB_ROOT,
      orgId: mb(0),
      staffCode: "OWN-001",
      displayName: "Kit Mbeki",
      kind: "human",
      userId: MB_OWNER_USER,
      positionTitle: "Owner",
      status: "active",
    },
    {
      id: MB_COS,
      orgId: mb(0),
      staffCode: "COS-001",
      displayName: "Robin",
      kind: "agent",
      roleId: mb(20),
      departmentId: mb(10),
      managerId: MB_ROOT,
      positionTitle: "Chief of Staff",
      status: "active",
    },
  ],
  // Deliberately a different price and a different phone from brightclean's.
  // A cross-org leak that shows the wrong number is then visible as a wrong
  // number rather than as a plausible one.
  facts: [
    {
      id: mb(40),
      orgId: mb(0),
      key: "business.phone",
      factType: "contact",
      value: { e164: "+15550177" },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: MB_ROOT,
      verifiedAt: AT,
      validFrom: AT,
    },
    {
      id: mb(41),
      orgId: mb(0),
      key: "pricing.standard_clean_hourly",
      factType: "pricing",
      value: { amount_minor: 2900, currency: "GBP" },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: MB_ROOT,
      verifiedAt: AT,
      validFrom: AT,
    },
  ],
  staffEvents: [
    {
      id: mb(50),
      orgId: mb(0),
      staffId: MB_COS,
      kind: "hired",
      actorStaffId: MB_ROOT,
      occurredAt: AT,
    },
  ],
  events: [
    {
      eventId: ulid("M", 0),
      orgId: mb(0),
      staffId: MB_COS,
      seq: 0,
      type: "staff.hired",
      occurredAt: AT,
      idempotencyKey: ulid("M", 1),
    },
  ],
}

// ---------------------------------------------------------------------------
// emptyco
// ---------------------------------------------------------------------------

const ec = (n: number) => id(3, n)

/**
 * An owner and nothing else. No staff, so not even the org root exists: an org
 * that has been created and not configured is the state every empty screen in
 * the app has to handle, and it is the one a fixture set usually forgets.
 */
export const emptyco: GoldenOrg = {
  slug: "emptyco",
  org: { id: ec(0), slug: "emptyco", name: "Emptyco Services (fixture)" },
  users: [
    {
      id: ec(1),
      orgId: ec(0),
      workosUserId: "user_fixture_emptyco_owner",
      email: "robin@emptyco.invalid",
      name: "Robin Alder",
    },
  ],
  roles: [],
  departments: [],
  staff: [],
  facts: [],
  staffEvents: [],
  events: [],
}

export const GOLDEN_ORGS = [brightclean, mopandbucket, emptyco] as const
