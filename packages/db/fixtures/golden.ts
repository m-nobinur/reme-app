import type {
  departments,
  events,
  facts,
  memberships,
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
type MembershipRow = typeof memberships.$inferInsert
type RoleRow = typeof roles.$inferInsert
type DepartmentRow = typeof departments.$inferInsert
type StaffRow = typeof staff.$inferInsert
type FactRow = typeof facts.$inferInsert
type StaffEventRow = typeof staffEvents.$inferInsert
type EventRow = typeof events.$inferInsert

export type GoldenOrg = {
  readonly slug: string
  readonly org: OrgRow
  /** People. Global rows: `users` is a platform table (ADR-028). */
  readonly users: UserRow[]
  /** What puts each of them in this org, and what `staff.user_id` points at. */
  readonly memberships: MembershipRow[]
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
    workosOrganizationId: "org_fixture_brightclean",
  },
  users: [
    {
      id: BC_OWNER_USER,
      workosUserId: "user_fixture_brightclean_owner",
      email: "dana@brightclean.invalid",
      name: "Dana Reyes",
    },
  ],
  memberships: [
    {
      id: bc(2),
      orgId: bc(0),
      userId: BC_OWNER_USER,
      workosMembershipId: "om_fixture_brightclean_owner",
      role: "owner",
      status: "active",
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
      // The name the site shows. Without it every build has to ask for it,
      // which is right for a business that never gave one and wrong for a
      // fixture meant to build.
      id: bc(46),
      orgId: bc(0),
      key: "business.name",
      factType: "identity",
      value: { name: "BrightClean" },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: BC_ROOT,
      verifiedAt: AT,
      validFrom: AT,
    },
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
      key: "service_area.text",
      factType: "service_area",
      value: { text: "Fairhaven and the villages within 25 km" },
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
      key: "service_area.text",
      factType: "service_area",
      value: { text: "Fairhaven" },
      version: 1,
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: BC_ROOT,
      verifiedAt: AT,
      validFrom: new Date("2025-06-01T09:00:00.000Z"),
      validTo: AT,
      supersededByFactId: bc(44),
    },
    // What the owner has said about the business beyond its contact details:
    // the material a marketing page is built from. Without these a build can
    // write a slogan and nothing else, because every checkable thing in
    // persuasive copy has to trace to a fact (ADR-033). Ids start at 60
    // because `staffEvents` below takes bc(50) to bc(56).
    //
    // The keys are the ones `packages/starter-site/src/site-config.ts`
    // declares, plus the prefixes `SUPPORTING_FACT_PREFIXES` in the claims
    // gate reads. No `media.photo_*`: the fixture holds no images, and a photo
    // fact pointing at a path that is not there is a broken page.
    {
      id: bc(60),
      orgId: bc(0),
      key: "business.tagline",
      factType: "identity",
      value: { tagline: "Cleaning you can plan your week around" },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: BC_ROOT,
      verifiedAt: AT,
      validFrom: AT,
    },
    {
      id: bc(61),
      orgId: bc(0),
      key: "differentiators.same_cleaner",
      factType: "differentiators",
      value: { statement: "The same cleaner comes back every visit" },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: BC_ROOT,
      verifiedAt: AT,
      validFrom: AT,
    },
    {
      id: bc(62),
      orgId: bc(0),
      key: "differentiators.own_supplies",
      factType: "differentiators",
      value: { statement: "We bring our own supplies and equipment" },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: BC_ROOT,
      verifiedAt: AT,
      validFrom: AT,
    },
    {
      id: bc(63),
      orgId: bc(0),
      key: "differentiators.fixed_window",
      factType: "differentiators",
      value: {
        statement: "Every clean is booked into a fixed two-hour window",
      },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: BC_ROOT,
      verifiedAt: AT,
      validFrom: AT,
    },
    {
      id: bc(64),
      orgId: bc(0),
      key: "about.story",
      factType: "about",
      value: {
        story:
          "Dana Reyes cleaned for a larger firm before starting BrightClean in Fairhaven, and still works alongside the team most weeks.",
      },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: BC_ROOT,
      verifiedAt: AT,
      validFrom: AT,
    },
    {
      id: bc(65),
      orgId: bc(0),
      key: "about.years_in_business",
      factType: "about",
      value: { years: 12 },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: BC_ROOT,
      verifiedAt: AT,
      validFrom: AT,
    },
    {
      id: bc(66),
      orgId: bc(0),
      key: "about.clients_served",
      factType: "about",
      value: { clients: 400 },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: BC_ROOT,
      verifiedAt: AT,
      validFrom: AT,
    },
    {
      id: bc(67),
      orgId: bc(0),
      key: "guarantees.put_it_right",
      factType: "guarantees",
      // The word "guarantee" is in the value and not only in the key: the
      // claims gate reads a fact's value, so copy may say "guarantee" only
      // because a fact says it.
      value: {
        statement:
          "Our put-it-right guarantee: tell us within two working days and we clean it again at no charge",
      },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: BC_ROOT,
      verifiedAt: AT,
      validFrom: AT,
    },
    {
      id: bc(68),
      orgId: bc(0),
      key: "credentials.insurance",
      factType: "credentials",
      value: { statement: "Fully insured and bonded" },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: BC_ROOT,
      verifiedAt: AT,
      validFrom: AT,
    },
    // Two reviews, each as a quote and an author, because the starter's
    // `testimonials.quote_1` and `testimonials.author_1` are two fields. The
    // quotes carry no number: a testimonial is matched as text, so a figure
    // inside one would be a second claim to support.
    {
      id: bc(69),
      orgId: bc(0),
      key: "testimonials.quote_1",
      factType: "testimonials",
      value: {
        quote:
          "They worked around my hours and the kitchen has never looked so clean.",
      },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: BC_ROOT,
      verifiedAt: AT,
      validFrom: AT,
    },
    {
      id: bc(70),
      orgId: bc(0),
      key: "testimonials.author_1",
      factType: "testimonials",
      value: { author: "Marta L." },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: BC_ROOT,
      verifiedAt: AT,
      validFrom: AT,
    },
    {
      id: bc(71),
      orgId: bc(0),
      key: "testimonials.quote_2",
      factType: "testimonials",
      value: {
        quote:
          "Booking was simple and the team left the place spotless without me having to chase anyone.",
      },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: BC_ROOT,
      verifiedAt: AT,
      validFrom: AT,
    },
    {
      id: bc(72),
      orgId: bc(0),
      key: "testimonials.author_2",
      factType: "testimonials",
      value: { author: "Owen B." },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: BC_ROOT,
      verifiedAt: AT,
      validFrom: AT,
    },
    {
      id: bc(73),
      orgId: bc(0),
      key: "reviews.average_rating",
      factType: "reviews",
      value: { rating: 4.8, out_of: 5 },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: BC_ROOT,
      verifiedAt: AT,
      validFrom: AT,
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
  // A hire belongs to no session, so it carries no `seq`: the aggregate is the
  // session and a number outside one orders nothing (ADR-028). Ordering across
  // these comes from `event_id`, which is a ULID.
  events: brightcleanHires.map((staffId, n) => ({
    eventId: ulid("B", n * 2),
    orgId: bc(0),
    staffId,
    sessionId: null,
    seq: null,
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
const MB_DEV = mb(32)

export const mopandbucket: GoldenOrg = {
  slug: "mopandbucket",
  org: {
    id: mb(0),
    slug: "mopandbucket",
    name: "Mop and Bucket Ltd. (fixture)",
    workosOrganizationId: "org_fixture_mopandbucket",
  },
  users: [
    {
      id: MB_OWNER_USER,
      workosUserId: "user_fixture_mopandbucket_owner",
      email: "kit@mopandbucket.invalid",
      name: "Kit Mbeki",
    },
  ],
  memberships: [
    {
      id: mb(2),
      orgId: mb(0),
      userId: MB_OWNER_USER,
      workosMembershipId: "om_fixture_mopandbucket_owner",
      role: "owner",
      status: "active",
    },
  ],
  roles: [
    {
      id: mb(20),
      orgId: mb(0),
      key: "chief_of_staff",
      title: "Chief of Staff",
    },
    { id: mb(21), orgId: mb(0), key: "developer", title: "Developer" },
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
    // A Developer, so a build can run on the thinner org: with a partial fact
    // set it asks before it edits, which is what the nightly wants to see.
    {
      id: MB_DEV,
      orgId: mb(0),
      staffCode: "DEV-001",
      displayName: "Sam",
      kind: "agent",
      roleId: mb(21),
      departmentId: mb(10),
      managerId: MB_COS,
      positionTitle: "Developer",
      status: "active",
    },
  ],
  // Deliberately a different area and a different phone from brightclean's.
  // A cross-org leak that shows the wrong number is then visible as a wrong
  // number rather than as a plausible one. Thin on purpose, and it stays thin:
  // the marketing facts brightclean carries would stop a build here asking.
  facts: [
    {
      id: mb(42),
      orgId: mb(0),
      key: "business.name",
      factType: "identity",
      value: { name: "Mop and Bucket" },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
      verifiedByStaffId: MB_ROOT,
      verifiedAt: AT,
      validFrom: AT,
    },
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
      key: "service_area.text",
      factType: "service_area",
      value: { text: "Harbourside and the old town" },
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
      sessionId: null,
      seq: null,
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
  org: {
    id: ec(0),
    slug: "emptyco",
    name: "Emptyco Services (fixture)",
    workosOrganizationId: "org_fixture_emptyco",
  },
  users: [
    {
      id: ec(1),
      workosUserId: "user_fixture_emptyco_owner",
      email: "robin@emptyco.invalid",
      name: "Robin Alder",
    },
  ],
  memberships: [
    {
      id: ec(2),
      orgId: ec(0),
      userId: ec(1),
      workosMembershipId: "om_fixture_emptyco_owner",
      role: "owner",
      status: "active",
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
