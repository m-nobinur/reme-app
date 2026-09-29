import { FactValue, type Org, type StaffDirectory } from "@workspace/contracts"
import {
  asc,
  conversationMessages,
  conversations,
  eq,
  memberships,
  orgs,
  resolveOrg,
  staff,
  supersedeFact,
  type Tenancy,
  toOrg,
  toStaffMember,
  users,
} from "@workspace/db"
import { firstMessage } from "./chat.ts"
import { ensureStartingTeam, rootStaffId } from "./staff.ts"
import { readFacts } from "./workspace.ts"

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
    userId: string
    statuses?: ("active" | "inactive" | "pending")[]
    limit: number
  }) => Promise<{ data: { id: string; organizationId: string }[] }>
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
export function slugFor(name: string, orgId: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  // `preview-` opens a preview host (ADR-030), so a name whose slug would
  // start that way, "Preview" alone included, gets a `site-` in front.
  const reserved = `${words}-`.startsWith("preview-")
  const base = (reserved ? `site-${words}` : words).slice(0, 40)
  return [base, orgId.slice(0, 8)].filter(Boolean).join("-")
}

/**
 * Creates the org: the WorkOS organization first, then ours.
 *
 * "Transactionally with the WorkOS organization" is not achievable and ADR-029
 * stopped asking for it: no transaction spans a vendor API and Postgres. What
 * holds instead is that a retry converges on one tenant, and the thing that
 * makes it converge is the membership rather than the idempotency key.
 *
 * ADR-029 assumed the vendor call was idempotent under the caller's key. It is
 * not, measured against WorkOS staging on 2026-08-29: two `POST /organizations`
 * with an identical `Idempotency-Key` answered 201 twice with two different
 * organization ids. The header is sent, by the SDK and by the handler, and the
 * endpoint ignores it. So a signup replayed after a crash was
 * producing a second organization, a second `orgs` row and a second tenant for
 * one owner, which is exactly the case a half-finished signup is.
 *
 * The membership does not have that problem. An owner replaying signup already
 * belongs to the organization the first attempt created, so this reads that
 * first and adopts it, and only creates an organization for someone who belongs
 * to none. That converges whether the first attempt died before our write or
 * after it, and it needs no promise from the vendor. `resolveOrg` then finds
 * whatever we already wrote, and `orgs_workos_organization_key` refuses a
 * second row for one organization if two requests race.
 *
 * The consequence, and it is deliberate: this endpoint creates at most one
 * organisation per person. It is the signup writer, and a second business for
 * the same owner is a different story with a different shape.
 *
 * Our inserts, the starting team's included, run in one `withOrg` under the
 * id this function generated, so no policy is widened for them:
 * `orgs_org_isolation` passes because the row's id is the context,
 * `users_self_insert` because the context names the person signing up, and
 * `memberships_org_isolation` and `staff_org_isolation` on the same org id. None
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
  },
  newId: () => string = () => crypto.randomUUID()
): Promise<Org> {
  // The replay, and it has to be the first thing that happens: everything
  // after it either creates a vendor resource or writes a row.
  const existing = await directory.listOrganizationMemberships({
    userId: input.workosUserId,
    statuses: ["active"],
    limit: 1,
  })
  const adopted = existing.data[0]
  const organization = adopted
    ? { id: adopted.organizationId }
    : await directory.createOrganization(
        { name: input.name },
        { idempotencyKey: input.idempotencyKey }
      )
  const membership =
    adopted ??
    (await directory.createOrganizationMembership({
      organizationId: organization.id,
      userId: input.workosUserId,
    }))

  const identity = {
    workosUserId: input.workosUserId,
    workosOrganizationId: organization.id,
  }
  // Where a retry that got all the way through last time stops.
  const replayed = await resolveOrg(kit, identity)
  if (replayed) {
    const org = await readOrg(kit, replayed)
    if (org) return org
  }

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
      await ensureStartingTeam(db, {
        orgId,
        userId: person.id,
        ownerName: input.displayName ?? input.email,
      })
      const root = (await rootStaffId(db)) as string
      // The name sign-up asked for is the owner's statement of it, so
      // onboarding does not ask it again.
      const name = FactValue.safeParse({
        key: "business.name",
        value: { name: input.name },
      })
      if (name.success) {
        await supersedeFact(db, {
          orgId,
          key: name.data.key,
          factType: "business",
          value: name.data.value,
          provenance: {
            source: "owner_stated",
            confidence: 1,
            verifiedByStaffId: root,
          },
        })
      }
      // The new owner lands in onboarding: its conversation, and the first
      // question already asked. Ids made here, so nothing needs RETURNING.
      const conversationId = newId()
      await db.insert(conversations).values({
        id: conversationId,
        orgId,
        kind: "onboarding",
        createdByStaffId: root,
      })
      await db.insert(conversationMessages).values({
        conversationId,
        orgId,
        ...firstMessage(input.name, await readFacts(db), newId),
      })
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
