import { connect } from "../src/client.ts"
import {
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
 * One row in every table, so a migration can be proven against a database that
 * already holds data. This is a **probe, not the fixture set**: the golden orgs
 * (`brightclean`, `mopandbucket`, `emptyco`) are a later story and land in
 * `scripts/seed.mjs`. Nothing here is meant to be reused as test data.
 *
 * Every id is a literal and every insert ignores conflicts, so running it twice
 * changes nothing.
 */

const ORG = "00000000-0000-4000-8000-000000000001"
const USER = "00000000-0000-4000-8000-000000000002"
const ROLE = "00000000-0000-4000-8000-000000000003"
const DEPT = "00000000-0000-4000-8000-000000000004"
const ROOT = "00000000-0000-4000-8000-000000000005"
const COS = "00000000-0000-4000-8000-000000000006"
const FACT = "00000000-0000-4000-8000-000000000007"
const STAFF_EVENT = "00000000-0000-4000-8000-000000000008"

const { sql, db } = connect()

await db
  .insert(orgs)
  .values({ id: ORG, slug: "probe", name: "Probe Org" })
  .onConflictDoNothing()

await db
  .insert(users)
  .values({
    id: USER,
    orgId: ORG,
    workosUserId: "user_probe",
    email: "probe@example.invalid",
    name: "Probe Owner",
  })
  .onConflictDoNothing()

await db
  .insert(roles)
  .values({
    id: ROLE,
    orgId: ORG,
    key: "chief_of_staff",
    title: "Chief of Staff",
  })
  .onConflictDoNothing()

await db
  .insert(departments)
  .values({ id: DEPT, orgId: ORG, name: "Operations" })
  .onConflictDoNothing()

// The root is the owner's proxy record: the one staff row per org with no
// manager, which is what `staff_one_root_per_org` allows exactly one of.
await db
  .insert(staff)
  .values({
    id: ROOT,
    orgId: ORG,
    staffCode: "OWN-001",
    displayName: "Probe Owner",
    kind: "human",
    userId: USER,
    status: "active",
  })
  .onConflictDoNothing()

await db
  .insert(staff)
  .values({
    id: COS,
    orgId: ORG,
    staffCode: "COS-001",
    displayName: "Probe CoS",
    kind: "agent",
    roleId: ROLE,
    departmentId: DEPT,
    managerId: ROOT,
    positionTitle: "Chief of Staff",
    status: "active",
  })
  .onConflictDoNothing()

await db
  .insert(facts)
  .values({
    id: FACT,
    orgId: ORG,
    key: "probe.value",
    factType: "probe",
    value: { probe: true },
    provenanceSource: "owner_stated",
    provenanceConfidence: 1,
    verifiedByStaffId: ROOT,
    verifiedAt: new Date(),
  })
  .onConflictDoNothing()

await db
  .insert(staffEvents)
  .values({
    id: STAFF_EVENT,
    orgId: ORG,
    staffId: COS,
    kind: "hired",
    actorStaffId: ROOT,
  })
  .onConflictDoNothing()

// Fixed ULIDs rather than generated ones, so a second run collides on
// (org_id, idempotency_key) and inserts nothing.
await db
  .insert(events)
  .values({
    eventId: "01K3ZPQRSTVWXYZ01234567890",
    orgId: ORG,
    staffId: COS,
    seq: 0,
    type: "staff.hired",
    occurredAt: new Date(),
    idempotencyKey: "01K3ZPQRSTVWXYZ01234567891",
  })
  .onConflictDoNothing()

const [counts] = await sql`
  select
    (select count(*)::int from orgs) as orgs,
    (select count(*)::int from users) as users,
    (select count(*)::int from roles) as roles,
    (select count(*)::int from departments) as departments,
    (select count(*)::int from staff) as staff,
    (select count(*)::int from facts) as facts,
    (select count(*)::int from staff_events) as staff_events,
    (select count(*)::int from events) as events`
console.log("probe rows:", counts)
await sql.end()
