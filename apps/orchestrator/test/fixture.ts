import {
  assignments,
  eq,
  memberships,
  orgs,
  staff,
  type Tenancy,
  users,
} from "@workspace/db"

/**
 * A fresh fictional org per case with the two staff rows an assignment needs,
 * written through `withOrg` so the suite holds nothing the app role cannot.
 * Rows stay behind: `events` is append-only, so nothing here can delete them.
 */
export async function freshOrg(kit: Tenancy): Promise<string> {
  const orgId = crypto.randomUUID()
  await kit.withOrg({ orgId }, async (db) => {
    await db.insert(orgs).values({
      id: orgId,
      slug: `state-test-${orgId.slice(0, 8)}`,
      name: "State machine probe (fixture)",
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
  kit: Tenancy,
  orgId: string,
  kind = "site.build"
) {
  return kit.withOrg({ orgId }, async (db) => {
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
 * A fresh fictional org whose only staff are the starting team, written the
 * way `apps/api`'s `ensureStartingTeam` writes it (which this app cannot
 * import): the owner as the human root, `COS-001` under the owner and
 * `DEV-001` under the Chief. The owner is a real person with a membership,
 * because a human staff row can only name one.
 */
export async function ownerOrg(kit: Tenancy) {
  const orgId = crypto.randomUUID()
  const workosUserId = `user_probe_${orgId}`
  const slug = `owner-test-${orgId.slice(0, 8)}`
  const ownerStaffId = await kit.withOrg(
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
      const hired = { orgId, status: "active" as const }
      await db.insert(staff).values({
        ...hired,
        staffCode: "OWN-001",
        displayName: "Sam Probe",
        kind: "human",
        userId: person?.id,
        positionTitle: "Owner",
      })
      const [owner] = await db
        .select({ id: staff.id })
        .from(staff)
        .where(eq(staff.staffCode, "OWN-001"))
      await db.insert(staff).values({
        ...hired,
        staffCode: "COS-001",
        displayName: "Maya",
        kind: "agent",
        managerId: owner?.id,
        positionTitle: "Chief of Staff",
      })
      const [chief] = await db
        .select({ id: staff.id })
        .from(staff)
        .where(eq(staff.staffCode, "COS-001"))
      await db.insert(staff).values({
        ...hired,
        staffCode: "DEV-001",
        displayName: "Alex",
        kind: "agent",
        managerId: chief?.id,
        positionTitle: "Developer",
      })
      return owner?.id as string
    }
  )
  return { orgId, slug, ownerStaffId }
}
