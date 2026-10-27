import { and, eq, inArray, sql } from "drizzle-orm"
import { connect } from "../src/client.ts"
import {
  approvals,
  assignments,
  assignmentTransitions,
  conversationMessages,
  conversations,
  deliveries,
  departments,
  deployments,
  domains,
  events,
  facts,
  jobRuns,
  memberships,
  orgs,
  ownerTasks,
  pushSubscriptions,
  reminders,
  roles,
  scheduledJobs,
  searchConnections,
  searchDaily,
  searchProperties,
  searchSnapshot,
  searchUrlStatus,
  siteRevisions,
  staff,
  staffEvents,
  taskFollowups,
  users,
} from "../src/schema.ts"
import { GOLDEN_ORGS } from "./golden.ts"

/**
 * Writes the golden orgs from `golden.ts`. Run it with `pnpm seed`, or
 * `pnpm seed --reset` to clear the three orgs first so the database matches the
 * file exactly.
 *
 * ## Which connection this uses, and why it is not `withOrg`
 *
 * The migrator connection, the same one `scripts/migrate.ts` and
 * `tenancy/fixtures.ts` use. Not a bypass added for convenience, and `withOrg`
 * is untouched: seeding is a platform operation and `withOrg` is the
 * per-request tenant path, which by construction cannot do it.
 *
 * Three reasons, and the first two are structural rather than awkward:
 *
 * 1. `--reset` deletes rows from `events` and `staff_events`, which are
 *    append-only. Migration 0003 revoked DELETE on both from `reme_app`
 *    deliberately, so a tenant can never erase its own audit trail. A seed that
 *    could clear them through the tenant path would mean that revoke was
 *    missing.
 * 2. The clear has to span all three orgs in one transaction. `withOrg` sets one
 *    `app.org_id` per transaction, so three orgs is three transactions and a
 *    reader can observe the gap between them.
 * 3. `withOrg` opens a lazy module-level pool and exports no way to close it, so
 *    a Node script that used it would never exit. That one is a gap in the
 *    tenancy kit rather than a reason, and the seed does not paper over it: the
 *    tenant-path read is asserted from vitest in `seed.test.ts` instead, which
 *    is where the seeded rows are proven visible through the policies rather
 *    than only through the role that wrote them.
 *
 * ## Concurrency
 *
 * One transaction, under a transaction-scoped advisory lock. Two `pnpm seed`
 * runs against one database therefore queue instead of interleaving, and a
 * reader never sees a half-cleared org.
 *
 * The lock is load-bearing rather than defensive. Measured 2026-08-27 against a
 * Neon branch, two concurrent `pnpm seed --reset` runs: with the lock, both
 * succeeded on 3 of 3 attempts; with the lock removed, one of the two failed on
 * every attempt with `update or delete on table ... violates foreign key
 * constraint`, because the second run's cascade of deletes ran against rows the
 * first was re-inserting. Transaction-scoped rather than session-scoped, so it
 * is released by the commit or the rollback and needs no `finally`.
 *
 * What that does not cover: two suite runs sharing one database, where one
 * calls `--reset` while the other is asserting. Fixed ids are the point of a
 * golden fixture, so no id scheme avoids it. The model is one database per
 * runner, which is what the repo already does: CI's `database` job gets its own
 * service container and a developer gets their own Neon branch.
 */

/** Distinct from the migration lock in `scripts/migrate.ts`. */
const LOCK_ID = 4027431101

type Handle = ReturnType<typeof connect>["db"]
/** The handle `db.transaction` hands its callback. */
export type Tx = Parameters<Parameters<Handle["transaction"]>[0]>[0]

/**
 * Deletes every row belonging to `orgIds`, deepest dependency first, and the
 * people named in `userIds`.
 *
 * Exported because `tenancy/fixtures.ts` clears its own probe orgs the same
 * way, and two hand-maintained copies of a dependency-ordered delete list drift
 * apart. `facts` references `staff`, and `staff` references `departments`,
 * `memberships` and itself, so a partial clear leaves a foreign key violation
 * for the next run rather than an empty database.
 *
 * `users` is a platform table (ADR-028), so its rows belong to no org and no
 * org id can find them. The caller passes the ids it created rather than this
 * deleting whoever is left without a membership, which would reach rows it
 * never wrote.
 *
 * The order is still maintained by hand. A tenant table added to the schema and
 * forgotten here surfaces as a foreign key violation on `delete from orgs` that
 * names the constraint, and the constraint names the table.
 */
export async function clearOrgs(
  tx: Tx,
  orgIds: readonly string[],
  userIds: readonly string[]
) {
  const ids = [...orgIds]
  // The builder track's tables first: a transition cites an event, and both
  // cite the assignment.
  await tx
    .delete(assignmentTransitions)
    .where(inArray(assignmentTransitions.orgId, ids))
  // Search Console's reports cite their property, which cites the org.
  for (const table of [
    searchUrlStatus,
    searchSnapshot,
    searchDaily,
    searchProperties,
    searchConnections,
  ]) {
    await tx.delete(table).where(inArray(table.orgId, ids))
  }
  // A step cites its task; its delete cascades, so the task alone is enough.
  for (const table of [taskFollowups, ownerTasks]) {
    await tx.delete(table).where(inArray(table.orgId, ids))
  }
  // A domain cites its approval, so it goes before the approvals.
  await tx.delete(domains).where(inArray(domains.orgId, ids))
  // A run cites its job; a job points at a reminder, with no key to say so.
  await tx.delete(deliveries).where(inArray(deliveries.orgId, ids))
  await tx
    .delete(pushSubscriptions)
    .where(inArray(pushSubscriptions.orgId, ids))
  await tx.delete(jobRuns).where(inArray(jobRuns.orgId, ids))
  await tx.delete(scheduledJobs).where(inArray(scheduledJobs.orgId, ids))
  // A reminder and a message cite their conversation, and a conversation its
  // creator.
  await tx.delete(reminders).where(inArray(reminders.orgId, ids))
  await tx
    .delete(conversationMessages)
    .where(inArray(conversationMessages.orgId, ids))
  await tx.delete(conversations).where(inArray(conversations.orgId, ids))
  // A deployment cites an approval and revisions; an approval cites both.
  await tx.delete(deployments).where(inArray(deployments.orgId, ids))
  await tx.delete(approvals).where(inArray(approvals.orgId, ids))
  await tx.delete(siteRevisions).where(inArray(siteRevisions.orgId, ids))
  await tx.delete(assignments).where(inArray(assignments.orgId, ids))
  await tx.delete(events).where(inArray(events.orgId, ids))
  await tx.delete(staffEvents).where(inArray(staffEvents.orgId, ids))
  await tx.delete(facts).where(inArray(facts.orgId, ids))
  await tx.delete(staff).where(inArray(staff.orgId, ids))
  await tx.delete(departments).where(inArray(departments.orgId, ids))
  await tx.delete(memberships).where(inArray(memberships.orgId, ids))
  if (userIds.length > 0) {
    await tx.delete(users).where(inArray(users.id, [...userIds]))
  }
  await tx.delete(roles).where(inArray(roles.orgId, ids))
  await tx.delete(orgs).where(inArray(orgs.id, ids))
}

/** Rows written per table. Printed by the script, asserted by the suite. */
export type SeedCounts = Record<string, number>

/**
 * Seeds the golden orgs and returns what it wrote.
 *
 * Without `reset`, every insert is `on conflict do nothing`, so a second run
 * changes nothing and the script is safe on a database that already holds other
 * data. That also means it will not update a row whose fixture changed:
 * `--reset` is how a database is brought back in line with the file.
 */
export async function seedGolden({ reset = false } = {}): Promise<SeedCounts> {
  const { sql: client, db } = connect()
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_ID})`)
      const ids = GOLDEN_ORGS.map((o) => o.org.id as string)
      if (reset) {
        await clearOrgs(
          tx,
          ids,
          GOLDEN_ORGS.flatMap((o) => o.users.map((u) => u.id as string))
        )
      }

      const counts: SeedCounts = {}
      // Counts what the database actually took, not what was offered: every
      // insert is `on conflict do nothing`, so a second run reports zeros. That
      // is the idempotency evidence rather than a claim about it.
      const write = async (
        table: string,
        rows: unknown[],
        run: () => Promise<{ length: number }>
      ) => {
        // drizzle rejects an empty `values([])`, and `emptyco` is empty rows on
        // purpose.
        if (rows.length === 0) return
        const written = await run()
        counts[table] = (counts[table] ?? 0) + written.length
      }

      for (const org of GOLDEN_ORGS) {
        // Table order is dependency order, and inside `staff` the array order is
        // too: a manager has to exist before the row reporting to it. Each is
        // one multi-row insert, which the self-reference survives because a
        // foreign key is an after-row trigger and those fire at statement end.
        await write("orgs", [org.org], () =>
          tx.insert(orgs).values(org.org).onConflictDoNothing().returning()
        )
        await write("users", org.users, () =>
          tx.insert(users).values(org.users).onConflictDoNothing().returning()
        )
        await write("memberships", org.memberships, () =>
          tx
            .insert(memberships)
            .values(org.memberships)
            .onConflictDoNothing()
            .returning()
        )
        await write("roles", org.roles, () =>
          tx.insert(roles).values(org.roles).onConflictDoNothing().returning()
        )
        await write("departments", org.departments, () =>
          tx
            .insert(departments)
            .values(org.departments)
            .onConflictDoNothing()
            .returning()
        )
        await write("staff", org.staff, () =>
          tx.insert(staff).values(org.staff).onConflictDoNothing().returning()
        )
        await write("facts", org.facts, () =>
          tx.insert(facts).values(org.facts).onConflictDoNothing().returning()
        )
        await write("staff_events", org.staffEvents, () =>
          tx
            .insert(staffEvents)
            .values(org.staffEvents)
            .onConflictDoNothing()
            .returning()
        )
        await write("events", org.events, () =>
          tx.insert(events).values(org.events).onConflictDoNothing().returning()
        )
      }
      return counts
    })
  } finally {
    await client.end()
  }
}

/**
 * Clears the local mirror of one person: their orgs named `orgName`, and their
 * user row. The other half of deleting a WorkOS user, for `pnpm dev:session
 * --delete`.
 *
 * Needed because `users.email` is unique and the WorkOS id is not carried over:
 * a user deleted and made again under the same address is a new WorkOS id, and
 * `createOrg` then meets the old row on the email and fails. The migrator
 * connection for the reasons `seedGolden` gives. Matching on the name as well
 * as the person means an org they joined any other way stays, and then the
 * user delete fails on its foreign key rather than taking that org with it.
 */
export async function clearOwner(
  email: string,
  orgName: string
): Promise<{ orgs: number; users: number }> {
  const { sql: client, db } = connect()
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_ID})`)
      const people = (
        await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, email))
      ).map((row) => row.id)
      if (people.length === 0) return { orgs: 0, users: 0 }
      const owned = (
        await tx
          .selectDistinct({ id: orgs.id })
          .from(orgs)
          .innerJoin(memberships, eq(memberships.orgId, orgs.id))
          .where(
            and(inArray(memberships.userId, people), eq(orgs.name, orgName))
          )
      ).map((row) => row.id)
      await clearOrgs(tx, owned, people)
      return { orgs: owned.length, users: people.length }
    })
  } finally {
    await client.end()
  }
}
