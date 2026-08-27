import { eq } from "drizzle-orm"
import { beforeAll, expect, it } from "vitest"
import { connect } from "../src/client.ts"
import { events, staff, users } from "../src/schema.ts"
import { withOrg } from "../src/tenancy.ts"
import { brightclean, emptyco, mopandbucket } from "./golden.ts"
import { seedGolden } from "./seed.ts"

/**
 * The seed round trip, against a real database. Run by `pnpm test:seed`.
 *
 * The seed writes as the migrator, which holds BYPASSRLS, so a row it wrote is
 * not yet proof of anything: the policies could hide every one of them from the
 * app and the seed would still report success. So every read below goes through
 * `withOrg`, as the API will, which is the only way to know the fixtures are
 * usable rather than merely present.
 *
 * The hooks get 60 s for the same reason `tenancy/rls.test.ts` does: a Neon
 * compute that has suspended takes several seconds to answer its first query,
 * and vitest's ten-second default tears the seed down halfway through.
 */

/** Postgres `check_violation` and `foreign_key_violation`. */
const CHECK_VIOLATION = "23514"
const FOREIGN_KEY_VIOLATION = "23503"

beforeAll(async () => {
  // Reset rather than plain seed, so this starts from the fixture file
  // regardless of what the last run left. Running it here is also the proof
  // that a clear followed by an insert works: the deletes are ordered by
  // dependency by hand, and `facts` referencing `staff` means a wrong order
  // fails on a foreign key rather than quietly leaving rows behind.
  await seedGolden({ reset: true })
}, 60_000)

it("writes every fixture row on a reset", async () => {
  const counts = await seedGolden({ reset: true })
  expect(counts).toEqual({
    orgs: 3,
    users: 3,
    memberships: 3,
    roles: brightclean.roles.length + mopandbucket.roles.length,
    departments:
      brightclean.departments.length + mopandbucket.departments.length,
    staff: brightclean.staff.length + mopandbucket.staff.length,
    facts: brightclean.facts.length + mopandbucket.facts.length,
    staff_events:
      brightclean.staffEvents.length + mopandbucket.staffEvents.length,
    events: brightclean.events.length + mopandbucket.events.length,
  })
}, 60_000)

it("writes nothing on a second run without a reset", async () => {
  // Every count is what the database took rather than what was offered, so an
  // idempotent run is all zeros. Filtering leaves the offending table named in
  // the failure instead of a wall of zeros to read.
  const written = await seedGolden()
  expect(Object.entries(written).filter(([, n]) => n > 0)).toEqual([])
}, 60_000)

it("shows an org its own staff through the tenant path", async () => {
  const rows = await withOrg({ orgId: brightclean.org.id as string }, (db) =>
    db.select({ code: staff.staffCode }).from(staff)
  )
  expect(new Set(rows.map((r) => r.code))).toEqual(
    new Set(brightclean.staff.map((s) => s.staffCode))
  )
})

it("hides a neighbour's staff from an org that names them by id", async () => {
  const rows = await withOrg({ orgId: brightclean.org.id as string }, (db) =>
    db
      .select({ code: staff.staffCode })
      .from(staff)
      .where(eq(staff.orgId, mopandbucket.org.id as string))
  )
  expect(rows).toEqual([])
})

it("shows the smaller org only its own two", async () => {
  const rows = await withOrg({ orgId: mopandbucket.org.id as string }, (db) =>
    db.select({ code: staff.staffCode }).from(staff)
  )
  expect(rows).toHaveLength(mopandbucket.staff.length)
})

it("refuses a human staff row naming somebody from another org", async () => {
  // The property §5.2 rests on, and the one line of ADR-028 doing the most
  // work: `staff_user_fk` points at `memberships(org_id, user_id)`, so a human
  // staff row can only name a person who holds a membership in the same org.
  // Written as the migrator, so what refuses it is the foreign key rather than
  // a policy, which is the point: application code cannot forget it.
  const { sql: client, db } = connect()
  try {
    let refusal: { code?: string; constraint_name?: string } = {}
    try {
      await db.insert(staff).values({
        id: "10000001-0000-4000-8000-000000009002",
        orgId: brightclean.org.id as string,
        staffCode: "PROBE-001",
        displayName: "Someone Else's Owner",
        kind: "human",
        // A real person, with a real membership, in the neighbouring org.
        userId: mopandbucket.users[0]?.id as string,
        // Reporting to the org root, because a second row with no manager is
        // refused by `staff_one_root_per_org` first and this would then be
        // proving that constraint instead of the foreign key.
        managerId: brightclean.staff.find((row) => !row.managerId)
          ?.id as string,
        status: "draft",
      })
    } catch (error) {
      const seen = error as {
        code?: string
        constraint_name?: string
        cause?: { code?: string; constraint_name?: string }
      }
      refusal = seen.code ? seen : (seen.cause ?? {})
    }
    // The constraint by name, not only the class of error: `staff` carries five
    // foreign keys and a unique index that would each refuse some version of
    // this row, and only one of them is the property under test.
    expect(
      { code: refusal.code, constraint: refusal.constraint_name },
      "a cross-org human staff row was accepted"
    ).toEqual({ code: FOREIGN_KEY_VIOLATION, constraint: "staff_user_fk" })
  } finally {
    await client.end()
  }
}, 60_000)

it("refuses an event that numbers a stream it is not in", async () => {
  // The pairing `EventEnvelope` carries, in the database, proven rather than
  // assumed (ADR-028). Written as the migrator, which holds BYPASSRLS, so what
  // refuses this is the check constraint and not a policy. Both offending
  // combinations, because a constraint written one way round catches one.
  const { sql: client, db } = connect()
  try {
    const rejected = async (row: typeof events.$inferInsert) => {
      try {
        await db.insert(events).values(row)
      } catch (error) {
        // drizzle wraps the driver error, so the code can be one level down.
        const seen = error as { code?: string; cause?: { code?: string } }
        return seen.code ?? seen.cause?.code
      }
      await db.delete(events).where(eq(events.eventId, row.eventId))
      return undefined
    }
    const base = {
      orgId: brightclean.org.id as string,
      type: "session.probe",
      occurredAt: new Date(),
      idempotencyKey: "01K4SEEDP00000000000000001",
    }
    expect(
      await rejected({
        ...base,
        eventId: "01K4SEEDP00000000000000002",
        sessionId: null,
        seq: 0,
      }),
      "a seq outside a session was accepted"
    ).toBe(CHECK_VIOLATION)
    expect(
      await rejected({
        ...base,
        eventId: "01K4SEEDP00000000000000003",
        sessionId: "10000001-0000-4000-8000-000000009001",
        seq: null,
      }),
      "a session event with no seq was accepted"
    ).toBe(CHECK_VIOLATION)
  } finally {
    await client.end()
  }
}, 60_000)

it("gives the unconfigured org an owner and nothing else", async () => {
  const { people, seats } = await withOrg(
    { orgId: emptyco.org.id as string },
    async (db) => ({
      people: await db.select({ email: users.email }).from(users),
      seats: await db.select({ code: staff.staffCode }).from(staff),
    })
  )
  expect(people.map((p) => p.email)).toEqual([emptyco.users[0]?.email])
  expect(seats).toEqual([])
})
