import type { Org, StaffDirectory } from "@workspace/contracts"
import {
  asc,
  eq,
  memberships,
  orgs,
  resolveOrg,
  staff,
  type Tenancy,
  toOrg,
  toStaffMember,
  users,
} from "@workspace/db"

/**
 * The org read, the staff directory read and the write that gives them
 * something to read.
 *
 * Every function here takes an `orgId` that came out of `resolveOrg`, or, for
 * the writer, one this file generated. None of them takes one from a caller,
 * and the type does not stop that, so the rule lives in `index.ts`: the org id
 * is produced in one place, three lines above the handler that uses it.
 */

/** The read `withOrg` makes trivial: the policy is the where clause. */
export async function readOrg(
  kit: Tenancy,
  orgId: string
): Promise<Org | null> {
  return kit.withOrg({ orgId }, async (db) => {
    const [row] = await db.select().from(orgs).limit(1)
    return row ? toOrg(row) : null
  })
}

/**
 * Ordering is the API's, not the caller's: `staff_code`, which is unique per
 * org and stable, so two calls agree and the page cursor this will need later
 * has something to be a cursor over.
 */
export async function readStaffDirectory(
  kit: Tenancy,
  orgId: string
): Promise<StaffDirectory> {
  return kit.withOrg({ orgId }, async (db) => {
    const rows = await db.select().from(staff).orderBy(asc(staff.staffCode))
    return { staff: rows.map(toStaffMember) }
  })
}

/**
 * The two WorkOS calls the writer makes, as a parameter rather than an import.
 *
 * `index.ts` passes the real client. The point of the seam is that the whole
 * database half of signup can be exercised against a live Postgres without
 * creating an organization in a real WorkOS environment, which is a resource
 * with a lifetime rather than a test fixture.
 */
export type Directory = {
  createOrganization: (
    options: { name: string },
    requestOptions: { idempotencyKey: string }
  ) => Promise<{ id: string }>
  listOrganizationMemberships: (options: {
    organizationId: string
    userId: string
    limit: number
  }) => Promise<{ data: { id: string }[] }>
  createOrganizationMembership: (options: {
    organizationId: string
    userId: string
  }) => Promise<{ id: string }>
}

/**
 * A handle a person can be given for their org. Derived rather than accepted,
 * so a caller cannot probe which handles are taken, and suffixed with the
 * org's own id so it needs no uniqueness read to be unique. A slug the owner
 * chooses is a later story; this one only has to be stable and theirs.
 */
function slugFor(name: string, orgId: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return [base, orgId.slice(0, 8)].filter(Boolean).join("-")
}

/**
 * Creates the org: the WorkOS organization first, then ours.
 *
 * "Transactionally with the WorkOS organization" is not achievable and ADR-029
 * stopped asking for it: no transaction spans a vendor API and Postgres. What
 * holds instead is that the vendor call is idempotent under the caller's key
 * and our write is idempotent against its result, so a crash between the two
 * leaves a WorkOS organization we adopt on the retry rather than a second
 * tenant. `orgs_workos_organization_key` is what makes the second half true,
 * and `resolveOrg` is how the retry finds what it already wrote.
 *
 * Our three inserts run in one `withOrg` under the id this function generated,
 * so no policy is widened for them: `orgs_org_isolation` passes because the
 * row's id is the context, `users_self_insert` because the context names the
 * person signing up, and `memberships_org_isolation` on the same org id. None
 * of them uses RETURNING, because the SELECT policy is applied to returned rows
 * and reports the refusal as an insert failure against the wrong policy.
 */
export async function createOrg(
  kit: Tenancy,
  directory: Directory,
  input: {
    name: string
    idempotencyKey: string
    workosUserId: string
    email: string
    displayName: string | null
  }
): Promise<Org> {
  const organization = await directory.createOrganization(
    { name: input.name },
    { idempotencyKey: input.idempotencyKey }
  )
  const identity = {
    workosUserId: input.workosUserId,
    workosOrganizationId: organization.id,
  }

  // Read before create, not as an optimisation: this is the replay. A retry
  // gets the same WorkOS organization back from the idempotency key, and this
  // is where it finds the tenant it already made.
  const replayed = await resolveOrg(kit, identity)
  if (replayed) {
    const org = await readOrg(kit, replayed)
    if (org) return org
  }

  const existing = await directory.listOrganizationMemberships({
    organizationId: organization.id,
    userId: input.workosUserId,
    limit: 1,
  })
  const membership =
    existing.data[0] ??
    (await directory.createOrganizationMembership({
      organizationId: organization.id,
      userId: input.workosUserId,
    }))

  const orgId = crypto.randomUUID()
  const written = await kit.withOrg(
    { orgId, workosUserId: input.workosUserId },
    async (db) => {
      const inserted = await db
        .insert(orgs)
        .values({
          id: orgId,
          slug: slugFor(input.name, orgId),
          name: input.name,
          workosOrganizationId: organization.id,
        })
        .onConflictDoNothing()
      // Someone else mirrored this organization between the resolve above and
      // this insert. Everything after would write into an org that is not the
      // one that exists, so it stops here and the caller re-resolves.
      if ((inserted as unknown as { count: number }).count === 0) return false

      await db
        .insert(users)
        .values({
          workosUserId: input.workosUserId,
          email: input.email,
          name: input.displayName,
        })
        .onConflictDoNothing()
      // Read back rather than returned. The person may already have a row from
      // an earlier org, in which case the id above was never used, and
      // `users_self_read` is the policy that lets them find their own.
      const [person] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.workosUserId, input.workosUserId))
        .limit(1)
      if (!person) {
        throw new Error("the user row was neither inserted nor readable")
      }

      await db
        .insert(memberships)
        .values({
          orgId,
          userId: person.id,
          workosMembershipId: membership.id,
          role: "owner",
          status: "active",
        })
        .onConflictDoNothing()
      return true
    }
  )

  const settled = written ? orgId : await resolveOrg(kit, identity)
  const org = settled ? await readOrg(kit, settled) : null
  if (!org) {
    throw new Error("the org was written and could not be read back")
  }
  return org
}
