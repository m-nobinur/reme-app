import { eq } from "drizzle-orm"
import { clearOrgs } from "../fixtures/seed.ts"
import { connect } from "../src/client.ts"
import {
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

/**
 * One person per org, in the platform `users` table. Exported because the
 * suite's platform-table probe names the row it expects each org to see and
 * the row it must not: a global table has no `org_id` to filter on, so the
 * denial has to be written as an id.
 */
export const USER_OF = { a: per("a", 1), b: per("b", 1) } as const

/**
 * The vendor ids the org resolver joins on. Exported for the same reason as
 * `USER_OF`: the refusal the suite drives is one org's person against the other
 * org's WorkOS id, and both halves have to be nameable from the test.
 */
export const WORKOS_USER_OF = {
  a: "user_tenancy_a",
  b: "user_tenancy_b",
} as const

export const WORKOS_ORG_OF = {
  a: "org_tenancy_a",
  b: "org_tenancy_b",
} as const

/**
 * A person who holds a membership in org A that is not active. ADR-029 makes
 * the resolver refuse one, and a refusal with nobody in that state to refuse is
 * an assertion about nothing.
 */
export const USER_PENDING = per("a", 8)
export const WORKOS_USER_PENDING = "user_tenancy_pending"

export async function seedTwoOrgs() {
  // Clearing first rather than repeating the delete list: two copies of a
  // dependency-ordered list drift, and the copy that drifts is the one nobody
  // reads.
  await clearTwoOrgs()
  const { sql, db } = connect()

  await db.insert(orgs).values([
    {
      id: ORG_A,
      slug: "tenancy-probe-a",
      name: "Tenancy Probe A",
      workosOrganizationId: WORKOS_ORG_OF.a,
    },
    {
      id: ORG_B,
      slug: "tenancy-probe-b",
      name: "Tenancy Probe B",
      workosOrganizationId: WORKOS_ORG_OF.b,
    },
  ])

  // org_id NULL: the platform template every org may read and none may write.
  await db.insert(roles).values({
    id: PLATFORM_ROLE,
    key: "chief_of_staff",
    title: "Chief of Staff",
  })

  // Somebody in org A whose membership never went active.
  await db.insert(users).values({
    id: USER_PENDING,
    workosUserId: WORKOS_USER_PENDING,
    email: "pending@tenancy-probe-a.invalid",
    name: "Tenancy Probe Invitee",
  })
  await db.insert(memberships).values({
    id: per("a", 9),
    orgId: ORG_A,
    userId: USER_PENDING,
    workosMembershipId: "om_tenancy_pending",
    role: "member",
    status: "pending",
  })

  for (const [tag, org] of [
    ["a", ORG_A],
    ["b", ORG_B],
  ] as const) {
    // A person, then their membership. `users` is a platform table now, so the
    // row itself belongs to nobody and the membership is what puts them in an
    // org (ADR-028).
    await db.insert(users).values({
      id: USER_OF[tag],
      workosUserId: WORKOS_USER_OF[tag],
      email: `owner@tenancy-probe-${tag}.invalid`,
      name: "Tenancy Probe Owner",
    })
    await db.insert(memberships).values({
      id: per(tag, 7),
      orgId: org,
      userId: USER_OF[tag],
      workosMembershipId: `om_tenancy_${tag}`,
      role: "owner",
      status: "active",
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
      userId: USER_OF[tag],
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
      // A lifecycle event belongs to no session, so it carries no seq
      // (ADR-028). The check constraint refuses the other three combinations.
      sessionId: null,
      seq: null,
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
 * The dependency-ordered deletes are `clearOrgs`, shared with the golden seed
 * rather than written out a second time here: two hand-maintained copies of
 * that order drift, and the copy that drifts is the one nobody reads. The
 * platform role template belongs to no org, so it is the one delete this file
 * still owns.
 */
export async function clearTwoOrgs() {
  const { sql, db } = connect()
  try {
    await db.transaction(async (tx) => {
      await clearOrgs(tx, [ORG_A, ORG_B], [USER_OF.a, USER_OF.b, USER_PENDING])
      await tx.delete(roles).where(eq(roles.id, PLATFORM_ROLE))
    })
  } finally {
    await sql.end()
  }
}
