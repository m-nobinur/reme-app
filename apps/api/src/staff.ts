import {
  ensureStartingTeam,
  eq,
  type OrgScopedDb,
  rootStaffId,
  users,
} from "@workspace/db"

/**
 * The owner's place in the starting team. A leaf: it reads `users`, and
 * imports no other api module, so the change path and the Chief of Staff can
 * reach it without reaching a conversation (ADR-034).
 */

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
