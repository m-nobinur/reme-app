import {
  appendEvent,
  eq,
  memberships,
  resolveOrg,
  sql,
  type Tenancy,
  users,
} from "@workspace/db"
import type { Session } from "./session.ts"
import { rootStaffId } from "./staff.ts"

/**
 * Deleting an owner's account (ADR-035): the email is freed and the WorkOS
 * identity removed, and the org's rows stay behind as an org nobody can
 * resolve until the §10.5 erasure job exists. Nothing here deletes a row.
 */

/** The three WorkOS calls deletion makes, as a parameter so tests stand in. */
export type Accounts = {
  listOrganizationMemberships: (options: {
    organizationId: string
    statuses: "active"[]
    limit: number
  }) => Promise<{ data: { userId: string }[] }>
  deleteOrganization: (id: string) => Promise<void>
  deleteUser: (id: string) => Promise<void>
}

/**
 * What a deleted person's `users.email` becomes: unique by the row's own id,
 * and on `.invalid` (RFC 2606), so it never collides and never receives mail.
 */
export const tombstone = (userId: string) => `deleted+${userId}@invalid`

type Signed = NonNullable<Session>

/**
 * Deletes the caller's account. The database first, in one transaction, so a
 * WorkOS failure leaves a state a second call finishes: that call finds the
 * org unresolvable (the membership is inactive), finds the caller's row
 * already tombstoned, and goes straight to the WorkOS half, where "already
 * gone" counts as done.
 */
export async function deleteAccount(
  kit: Tenancy,
  accounts: Accounts,
  session: Signed
): Promise<"deleted" | "not_owner" | "other_members" | "unresolved"> {
  const orgId = session.workosOrganizationId
    ? await resolveOrg(kit, {
        workosUserId: session.workosUserId,
        workosOrganizationId: session.workosOrganizationId,
      })
    : null

  if (orgId) {
    const refused = await kit.withOrg(
      { orgId, workosUserId: session.workosUserId },
      async (db) => {
        const active = await db
          .select({
            membershipId: memberships.id,
            role: memberships.role,
            workosUserId: users.workosUserId,
          })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(eq(memberships.status, "active"))
        const own = active.find((m) => m.workosUserId === session.workosUserId)
        if (own?.role !== "owner") return "not_owner" as const
        if (active.length > 1) return "other_members" as const

        await db
          .update(users)
          .set({
            email: sql`'deleted+' || ${users.id} || '@invalid'`,
            name: null,
          })
          .where(eq(users.workosUserId, session.workosUserId))
        const ended = await db
          .update(memberships)
          .set({ status: "inactive" })
          .where(
            sql`${memberships.id} = ${own.membershipId} and ${memberships.status} = 'active'`
          )
        // A concurrent call that got here first already logged it.
        if ((ended as unknown as { count: number }).count === 1) {
          await appendEvent(db, {
            orgId,
            assignmentId: null,
            staffId: await rootStaffId(db),
            type: "account.deleted",
            payload: {},
          })
        }
        return null
      }
    )
    if (refused) return refused
  } else if (!(await tombstoned(kit, session.workosUserId))) {
    return "unresolved"
  }

  await removeIdentity(accounts, session)
  return "deleted"
}

/**
 * Whether the caller's own row is already a tombstone. Read under a fresh org
 * id, the way `createOrg` writes the row, so no tenant row is visible and
 * `users_self_read` is the only policy that matches.
 */
async function tombstoned(kit: Tenancy, workosUserId: string) {
  const [row] = await kit.withOrg(
    { orgId: crypto.randomUUID(), workosUserId },
    (db) =>
      db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.workosUserId, workosUserId))
  )
  return row !== undefined && row.email === tombstone(row.id)
}

/**
 * The WorkOS organization goes only when WorkOS itself lists nobody else in
 * it, since the retry path has no database row to check against. Then the
 * user, which ends their sessions.
 */
async function removeIdentity(accounts: Accounts, session: Signed) {
  const organizationId = session.workosOrganizationId
  if (organizationId) {
    const members = await unlessGone(
      accounts.listOrganizationMemberships({
        organizationId,
        statuses: ["active"],
        limit: 2,
      })
    )
    if (members?.data.every((m) => m.userId === session.workosUserId)) {
      await unlessGone(accounts.deleteOrganization(organizationId))
    }
  }
  await unlessGone(accounts.deleteUser(session.workosUserId))
}

/** A WorkOS 404 is the thing already gone, which is what a retry wants. */
const unlessGone = <T>(call: Promise<T>) =>
  call.catch((error: unknown) => {
    if ((error as { status?: unknown } | null)?.status === 404) return null
    throw error
  })
