import {
  FactValue,
  type Org,
  type StaffDirectory,
  slugFor,
} from "@workspace/contracts"
import {
  asc,
  conversationMessages,
  conversations,
  ensureHeartbeat,
  ensureStartingTeam,
  eq,
  memberships,
  orgs,
  resolveOrg,
  rootStaffId,
  sql,
  staff,
  supersedeFact,
  type Tenancy,
  toOrg,
  toStaffMember,
  users,
} from "@workspace/db"
import { firstMessage } from "./chat.ts"
import { firstName } from "./onboarding-copy.ts"
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
 * Another person's row holds this email: a WorkOS user deleted outside
 * `DELETE /account`, whose row was never tombstoned. `index.ts` answers 409.
 */
export class EmailTaken extends Error {}

/**
 * How long a signup's claim holds. Longer than a whole attempt can run (three
 * WorkOS calls bounded at 3 s each, then the writes), so only the claim of an
 * attempt that died is ever taken over.
 */
export const SIGNUP_LEASE_S = 30

/**
 * How long a second signup waits for the first. Under `apps/web`'s 10 s wait
 * for an answer, so the refusal below reaches it rather than its own timeout.
 */
export const SIGNUP_WAIT_MS = 8_000

const SIGNUP_POLL_MS = 500

/**
 * Another signup for this person is still running. Not caught in `index.ts`,
 * so it answers 503 `request.failed`, which `apps/web` already treats as a
 * write to retry.
 */
export class SignupBusy extends Error {}

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
 * Two signups at once for one person both read no membership, so each would
 * make an organization. The person's row carries a claim (`signupClaimedAt`):
 * the first takes it, and the second waits until it can take it in turn and
 * then adopts. No connection is held across the WorkOS calls; holding a lock
 * open there drained a 2-connection pool before (PR #296).
 *
 * The consequence, and it is deliberate: this endpoint creates at most one
 * organisation per person. It is the signup writer, and a second business for
 * the same owner is a different story with a different shape.
 *
 * The person is written first, in a transaction of its own that
 * `users_self_insert` passes because the context names the person signing up.
 * The org's inserts, the starting team's included, then run in one `withOrg`
 * under the id this function generated, so no policy is widened for them:
 * `orgs_org_isolation` passes because the row's id is the context, and
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
  newId: () => string = () => crypto.randomUUID(),
  waitMs = SIGNUP_WAIT_MS
): Promise<Org> {
  // The person first, before any vendor call, so an email another row holds
  // is refused before a WorkOS organization exists to be left behind. Under a
  // fresh org id, as the write below is, so `users_self_insert` and
  // `users_self_read` are the only policies that match. The insert does
  // nothing when the person is already mirrored or the email is taken; the
  // read tells the two apart, since only the first is their own row.
  const personId = await kit.withOrg(
    { orgId: crypto.randomUUID(), workosUserId: input.workosUserId },
    async (db) => {
      await db
        .insert(users)
        .values({
          workosUserId: input.workosUserId,
          email: input.email,
          name: input.displayName,
        })
        .onConflictDoNothing()
      const [person] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.workosUserId, input.workosUserId))
        .limit(1)
      return person?.id
    }
  )
  if (!personId) throw new EmailTaken()

  // One signup per person at a time. A second one waits, holding no
  // connection, and once it holds the claim it adopts what the first made.
  const deadline = Date.now() + waitMs
  let claimed = await claimSignup(kit, input.workosUserId)
  while (!claimed) {
    if (Date.now() >= deadline) throw new SignupBusy()
    await new Promise((resolve) => setTimeout(resolve, SIGNUP_POLL_MS))
    claimed = await claimSignup(kit, input.workosUserId)
  }
  try {
    return await writeOrg(kit, directory, input, personId, newId)
  } finally {
    // Cleared on failure too, so a retry goes straight in. A clear that fails
    // leaves the claim to lapse after the lease.
    await releaseSignup(kit, input.workosUserId, claimed).catch(() => undefined)
  }
}

/** The person's own row, as `users_self_update` allows, under a fresh org id. */
const asPerson = (workosUserId: string) => ({
  orgId: crypto.randomUUID(),
  workosUserId,
})

/**
 * Takes the claim, or null when a live one is held. One statement, committed
 * at once: a racing second update waits on the row lock, then reads the claim
 * the first wrote and matches nothing. Milliseconds, so the release can match
 * the stamp exactly as it comes back through a `Date`.
 */
async function claimSignup(
  kit: Tenancy,
  workosUserId: string
): Promise<Date | null> {
  return kit.withOrg(asPerson(workosUserId), async (db) => {
    const [row] = await db
      .update(users)
      .set({ signupClaimedAt: sql`date_trunc('milliseconds', now())` })
      .where(
        sql`${users.workosUserId} = ${workosUserId} and (${users.signupClaimedAt} is null
          or ${users.signupClaimedAt} < now() - make_interval(secs => ${SIGNUP_LEASE_S}))`
      )
      .returning({ at: users.signupClaimedAt })
    return row?.at ?? null
  })
}

/** Clears this attempt's claim, and not one a later attempt took over. */
async function releaseSignup(
  kit: Tenancy,
  workosUserId: string,
  at: Date
): Promise<void> {
  await kit.withOrg(asPerson(workosUserId), async (db) => {
    await db.update(users).set({ signupClaimedAt: null }).where(
      // As ISO text: a `Date` bound raw goes out in its local string form,
      // which drops the milliseconds and never matches.
      sql`${users.workosUserId} = ${workosUserId} and ${users.signupClaimedAt} = ${at.toISOString()}::timestamptz`
    )
  })
}

/** The org for a person who holds the signup claim: adopted or created. */
async function writeOrg(
  kit: Tenancy,
  directory: Directory,
  input: Parameters<typeof createOrg>[2],
  personId: string,
  newId: () => string
): Promise<Org> {
  // The replay: everything after it either creates a vendor resource or
  // writes a row.
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
        .insert(memberships)
        .values({
          orgId,
          userId: personId,
          workosMembershipId: membership.id,
          role: "owner",
          status: "active",
        })
        .onConflictDoNothing()
      await ensureStartingTeam(db, {
        orgId,
        userId: personId,
        ownerName: input.displayName ?? input.email,
      })
      const root = (await rootStaffId(db)) as string
      // The names sign-up asked for are the owner's statement of them, so
      // onboarding does not ask them again. The owner is called by their
      // first name, which the Chief of Staff reads from this fact.
      const first = firstName(input.displayName ?? "")
      for (const stated of [
        { key: "business.name", value: { name: input.name } },
        ...(first
          ? [{ key: "owner.preferred_name", value: { name: first } }]
          : []),
      ]) {
        const fact = FactValue.safeParse(stated)
        if (!fact.success) continue
        await supersedeFact(db, {
          orgId,
          key: fact.data.key,
          factType: fact.data.key.split(".")[0] ?? "fact",
          value: fact.data.value,
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
        ...firstMessage(
          { orgId, orgName: input.name, ownerName: input.displayName ?? "" },
          await readFacts(db),
          newId
        ),
      })
      // The first beat is hours away, so the scheduler's hourly fallback scan
      // finds it without lowering the KV guard from here.
      await ensureHeartbeat(db)
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
