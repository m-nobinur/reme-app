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
 * Two orgs with a row in every tenant table, plus one platform-level role
 * template that belongs to neither.
 *
 * Written through the migrator connection, which holds BYPASSRLS, so the
 * fixtures exist regardless of the policies the suite is about to test. They
 * are clearly fictional (R8) and they are not the golden orgs: `brightclean`,
 * `mopandbucket` and `emptyco` land with the seed story and are shared with the
 * UI and the evals. These exist to be denied.
 *
 * When a tenant table is added, add its rows here. The suite fails on a table
 * that has no row for org A, because cross-org denial against an empty table
 * proves nothing.
 */

const uuid = (n: number) =>
  `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`

export const ORG_A = uuid(1)
export const ORG_B = uuid(2)
/** An org id that is never inserted. Used to probe WITH CHECK on `orgs`. */
export const ORG_ABSENT = uuid(3)

const per = (org: "a" | "b", n: number) =>
  `00000000-0000-4000-${org === "a" ? "a" : "b"}000-${String(n).padStart(12, "0")}`

/** ULIDs are 26 chars of Crockford base32; the check constraint enforces it. */
const ulid = (org: "a" | "b", n: number) =>
  `01K3TENANCY${org.toUpperCase()}${String(n).padStart(14, "0")}`

const PLATFORM_ROLE = uuid(9)

export async function seedTwoOrgs() {
  // Clearing first rather than repeating the delete list: two copies of a
  // dependency-ordered list drift, and the copy that drifts is the one nobody
  // reads.
  await clearTwoOrgs()
  const { sql, db } = connect()

  await db.insert(orgs).values([
    { id: ORG_A, slug: "tenancy-probe-a", name: "Tenancy Probe A" },
    { id: ORG_B, slug: "tenancy-probe-b", name: "Tenancy Probe B" },
  ])

  // org_id NULL: the platform template every org may read and none may write.
  await db.insert(roles).values({
    id: PLATFORM_ROLE,
    key: "chief_of_staff",
    title: "Chief of Staff",
  })

  for (const [tag, org] of [
    ["a", ORG_A],
    ["b", ORG_B],
  ] as const) {
    await db.insert(users).values({
      id: per(tag, 1),
      orgId: org,
      workosUserId: `user_tenancy_${tag}`,
      email: `owner@tenancy-probe-${tag}.invalid`,
      name: "Tenancy Probe Owner",
    })
    await db.insert(roles).values({
      id: per(tag, 2),
      orgId: org,
      key: "chief_of_staff",
      title: "Chief of Staff",
    })
    await db.insert(departments).values({
      id: per(tag, 3),
      orgId: org,
      name: "Operations",
    })
    await db.insert(staff).values({
      id: per(tag, 4),
      orgId: org,
      staffCode: "OWN-001",
      displayName: "Tenancy Probe Owner",
      kind: "human",
      userId: per(tag, 1),
      status: "active",
    })
    await db.insert(facts).values({
      id: per(tag, 5),
      orgId: org,
      key: "tenancy.probe",
      factType: "probe",
      value: { probe: true },
      provenanceSource: "owner_stated",
      provenanceConfidence: 1,
    })
    await db.insert(staffEvents).values({
      id: per(tag, 6),
      orgId: org,
      staffId: per(tag, 4),
      kind: "hired",
    })
    await db.insert(events).values({
      eventId: ulid(tag, 1),
      orgId: org,
      staffId: per(tag, 4),
      seq: 0,
      type: "staff.hired",
      occurredAt: new Date(),
      idempotencyKey: ulid(tag, 2),
    })
  }
  await sql.end()
}

/**
 * Removes both probe orgs. Safe to run on a database that never had them, and
 * safe to run twice, which is what makes `seedTwoOrgs` able to open with it.
 *
 * One transaction, and that is the fix for a real flake rather than tidiness.
 * The deletes take about four seconds against Neon warm and longer against a
 * suspended compute, while vitest's default hook timeout is ten. As eight
 * separate statements, an `afterAll` that ran over left some tables cleared and
 * some not, and the next run's `beforeAll` walked into a foreign key it could
 * not satisfy. As one transaction it either all lands or none of it does, and
 * the caller sees the error either way. `rls.test.ts` also gives the hook the
 * same 60 s the seed has.
 *
 * The order is by dependency, deepest first, and it is maintained by hand. A
 * tenant table added to the seed and forgotten here surfaces as a foreign key
 * violation on `delete from orgs` that names the constraint, and the
 * constraint names the table.
 */
export async function clearTwoOrgs() {
  const { sql } = connect()
  try {
    await sql.begin(async (tx) => {
      await tx`delete from events where org_id in (${ORG_A}, ${ORG_B})`
      await tx`delete from staff_events where org_id in (${ORG_A}, ${ORG_B})`
      await tx`delete from facts where org_id in (${ORG_A}, ${ORG_B})`
      await tx`delete from staff where org_id in (${ORG_A}, ${ORG_B})`
      await tx`delete from departments where org_id in (${ORG_A}, ${ORG_B})`
      await tx`delete from users where org_id in (${ORG_A}, ${ORG_B})`
      await tx`delete from roles where org_id in (${ORG_A}, ${ORG_B}) or id = ${PLATFORM_ROLE}`
      await tx`delete from orgs where id in (${ORG_A}, ${ORG_B})`
    })
  } finally {
    await sql.end()
  }
}
