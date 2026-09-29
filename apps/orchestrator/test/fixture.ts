import {
  assignments,
  ensureStartingTeam,
  eq,
  memberships,
  orgs,
  rootStaffId,
  staff,
  type Tenancy,
  tenancy,
  users,
} from "@workspace/db"

/** One pool per suite file, on the database the suite was given, if any. */
export const kit: Tenancy = tenancy(
  process.env.DATABASE_URL ?? "postgres://unused"
)

/** Staging's site host suffix, the one every suite builds hosts under. */
export const SUFFIX = "-stg.remeai.co.uk"

/**
 * A fresh fictional org per case with the two staff rows an assignment needs
 * and an owner, since the publisher points nothing at an org nobody holds
 * (ADR-035), written through `withOrg` so the suite holds nothing the app
 * role cannot. Rows stay behind: `events` is append-only, so nothing here can
 * delete them.
 */
export async function freshOrg(pool: Tenancy): Promise<string> {
  const orgId = crypto.randomUUID()
  const workosUserId = `user_probe_${orgId}`
  await pool.withOrg({ orgId, workosUserId }, async (db) => {
    await db.insert(orgs).values({
      id: orgId,
      slug: `state-test-${orgId.slice(0, 8)}`,
      name: "State machine probe (fixture)",
    })
    await db.insert(users).values({
      workosUserId,
      email: `probe-${orgId}@example.test`,
    })
    const [person] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.workosUserId, workosUserId))
    await db.insert(memberships).values({
      orgId,
      userId: person?.id as string,
      workosMembershipId: `om_probe_${orgId}`,
      role: "owner",
      status: "active",
    })
    // One root per org: the Chief is the root and the Developer reports to it.
    const [chief] = await db
      .insert(staff)
      .values({
        orgId,
        staffCode: "COS-001",
        displayName: "Chief",
        kind: "agent",
        status: "active",
      })
      .returning({ id: staff.id })
    await db.insert(staff).values({
      orgId,
      staffCode: "DEV-001",
      displayName: "Dev",
      kind: "agent",
      status: "active",
      managerId: chief?.id,
    })
  })
  return orgId
}

export async function newAssignment(
  pool: Tenancy,
  orgId: string,
  kind = "site.build"
) {
  return pool.withOrg({ orgId }, async (db) => {
    const [dev] = await db
      .select({ id: staff.id })
      .from(staff)
      .where(eq(staff.staffCode, "DEV-001"))
    if (!dev) throw new Error("no developer")
    const [row] = await db
      .insert(assignments)
      .values({
        orgId,
        staffId: dev.id,
        createdByStaffId: dev.id,
        kind,
        goal: "probe",
        acceptanceCriteria: ["probe"],
        factSnapshotId: crypto.randomUUID(),
        budgetUsd: 1,
        idempotencyKey: crypto.randomUUID(),
      })
      .returning()
    if (!row) throw new Error("no row")
    return { orgId, assignmentId: row.id }
  })
}

/**
 * A fresh fictional org whose only staff are the starting team, written by
 * `ensureStartingTeam`, the call `apps/api` makes. The owner is a real person
 * with a membership, because a human staff row can only name one.
 */
export async function ownerOrg(pool: Tenancy) {
  const orgId = crypto.randomUUID()
  const workosUserId = `user_probe_${orgId}`
  const slug = `owner-test-${orgId.slice(0, 8)}`
  const ownerStaffId = await pool.withOrg(
    { orgId, workosUserId },
    async (db) => {
      await db.insert(orgs).values({
        id: orgId,
        slug,
        name: "Owner mode probe (fixture)",
      })
      await db.insert(users).values({
        workosUserId,
        email: `probe-${orgId}@example.test`,
      })
      const [person] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.workosUserId, workosUserId))
      await db.insert(memberships).values({
        orgId,
        userId: person?.id as string,
        workosMembershipId: `om_probe_${orgId}`,
        role: "owner",
        status: "active",
      })
      await ensureStartingTeam(db, {
        orgId,
        userId: person?.id as string,
        ownerName: "Sam Probe",
      })
      return (await rootStaffId(db)) as string
    }
  )
  return { orgId, slug, ownerStaffId }
}
