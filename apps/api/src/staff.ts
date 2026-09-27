import { eq, type OrgScopedDb, sql, staff, users } from "@workspace/db"

/**
 * The org's starting team and the owner's place in it. A leaf: it reads and
 * writes `staff` and reads `users`, and imports no other api module, so the
 * change path and the Chief of Staff can reach it without reaching a
 * conversation (ADR-034).
 */

/**
 * The team every org starts with (§5.2): the owner as the human root, a Chief
 * of Staff reporting to the root and a Developer reporting to the Chief, so
 * the first build has someone to run it. Names are the golden fixtures'. Role
 * and department stay null: a new org has no rows of either to point at.
 *
 * Safe to call again, and on an org made before this: each insert does
 * nothing on any unique conflict, the code or the one-root index, so a second
 * call adds nobody and an org whose root has another code keeps it. Each
 * manager comes from a subquery in the insert rather than a read back, so no
 * statement returns a row (the reason `createOrg` gives). `userId` is our
 * `users.id`, and the owner needs a membership in this org first, because
 * `staff_user_fk` points at it.
 */
export async function ensureStartingTeam(
  db: OrgScopedDb,
  team: { orgId: string; userId: string; ownerName: string }
): Promise<void> {
  const { orgId } = team
  const root = sql`(select ${staff.id} from ${staff} where ${staff.orgId} = ${orgId} and ${staff.kind} = 'human' and ${staff.managerId} is null)`
  const chief = sql`(select ${staff.id} from ${staff} where ${staff.orgId} = ${orgId} and ${staff.staffCode} = 'COS-001')`
  const hired = { orgId, status: "active" as const }
  await db
    .insert(staff)
    .values({
      ...hired,
      staffCode: "OWN-001",
      displayName: team.ownerName,
      kind: "human",
      userId: team.userId,
      positionTitle: "Owner",
    })
    .onConflictDoNothing()
  await db
    .insert(staff)
    .values({
      ...hired,
      staffCode: "COS-001",
      displayName: "Maya",
      kind: "agent",
      managerId: root,
      positionTitle: "Chief of Staff",
    })
    .onConflictDoNothing()
  await db
    .insert(staff)
    .values({
      ...hired,
      staffCode: "DEV-001",
      displayName: "Alex",
      kind: "agent",
      managerId: chief,
      positionTitle: "Developer",
    })
    .onConflictDoNothing()
}

/**
 * The owner's staff row, after making sure the org has its starting team: an
 * org made before the team existed gets it here. Null only when the person is
 * not mirrored, which the resolver that produced the org rules out. The
 * transaction needs `workosUserId` in its context to read the person.
 */
export async function ownerStaffId(
  db: OrgScopedDb,
  owner: { orgId: string; workosUserId: string; ownerName: string }
): Promise<string | null> {
  const [person] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.workosUserId, owner.workosUserId))
  if (person) {
    await ensureStartingTeam(db, {
      orgId: owner.orgId,
      userId: person.id,
      ownerName: owner.ownerName,
    })
  }
  return rootStaffId(db)
}

/** The org's human root, the owner's staff row, or null before the team exists. */
export async function rootStaffId(db: OrgScopedDb): Promise<string | null> {
  const [root] = await db
    .select({ id: staff.id })
    .from(staff)
    .where(sql`${staff.kind} = 'human' and ${staff.managerId} is null`)
  return root?.id ?? null
}
