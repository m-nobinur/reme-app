import { assignments, eq, orgs, staff, type Tenancy } from "@workspace/db"

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
