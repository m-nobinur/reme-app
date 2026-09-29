import {
  appendEvent,
  eq,
  memberships,
  resolveOrg,
  rootStaffId,
  sql,
  type Tenancy,
  tombstone,
  users,
} from "@workspace/db"
import type { Session } from "./session.ts"

/**
 * Deleting an owner's account (ADR-035): the site goes offline, the email is
 * freed and the WorkOS identity removed, and the org's rows stay behind as an
 * org nobody can resolve until the §10.5 erasure job exists. Nothing here
 * deletes a row.
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

/** Its format lives in `@workspace/db`, beside `orgOpen`, which reads it. */
export { tombstone }

/**
 * Takes the org's site offline and cancels its open builds, over the
 * orchestrator bridge. Throws when that did not happen; safe to repeat.
 */
export type Takedown = (orgId: string) => Promise<void>

type Signed = NonNullable<Session>

/**
 * Deletes the caller's account, in an order a retry can always finish:
 *
 * 1. Refuse unless the caller is the org's only active member and its owner,
 *    then tombstone their row. From this commit `orgOpen` reads the org as
 *    closed, so the router refills no pointer and the publisher writes none,
 *    and the membership is still active, so the org still resolves.
 * 2. Take the site down. A failure fails the route, and a retry resolves the
 *    org and takes it down again. Doing this after step 1 is what means no
 *    pointer can come back once it is gone.
 * 3. End the membership and log `account.deleted`. The org stops resolving.
 * 4. WorkOS last. A retry finds the org unresolvable and the caller's row
 *    already a tombstone, and goes straight here, where "already gone" counts
 *    as done.
 */
export async function deleteAccount(
  kit: Tenancy,
  accounts: Accounts,
  takedown: Takedown,
  session: Signed
): Promise<"deleted" | "not_owner" | "other_members" | "unresolved"> {
  const orgId = session.workosOrganizationId
    ? await resolveOrg(kit, {
        workosUserId: session.workosUserId,
        workosOrganizationId: session.workosOrganizationId,
      })
    : null

  if (orgId) {
    const ctx = { orgId, workosUserId: session.workosUserId }
    const checked = await kit.withOrg(ctx, async (db) => {
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
      return own
    })
    if (typeof checked === "string") return checked

    await takedown(orgId)

    await kit.withOrg(ctx, async (db) => {
      const ended = await db
        .update(memberships)
        .set({ status: "inactive" })
        .where(
          sql`${memberships.id} = ${checked.membershipId} and ${memberships.status} = 'active'`
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
    })
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
