import { ErrorEnvelope, Org, StaffDirectory } from "@workspace/contracts"
import {
  asc,
  eq,
  memberships,
  orgs,
  resolveOrg,
  sql,
  staff,
  tenancy,
  users,
} from "@workspace/db"
import { brightclean, emptyco } from "@workspace/db/fixtures"
import { afterAll, describe, expect, it } from "vitest"
import worker from "../src/index.ts"
import {
  createOrg,
  type Directory,
  ensureStartingTeam,
  readOrg,
  readStaffDirectory,
} from "../src/org.ts"

/**
 * Two halves, the same split `health.test.ts` uses. The routing half needs no
 * database and runs in the ordinary unit job; the rest needs one and runs in
 * the `database` job beside the tenancy gate.
 *
 * What is not here, and cannot be: a request carrying a real session. That
 * needs a WorkOS-signed access token, so it needs a user and an organization in
 * a real WorkOS environment. Staging has neither and creating them is outside
 * this story, so the authenticated path is exercised at the function the
 * handler calls, one line below where the session is read.
 */

const url = process.env.DATABASE_URL

/**
 * `waitUntil` is the only thing the handler asks of the context. It is given a
 * real one rather than a no-op, because the handler closes the pool through it
 * and a stub that dropped the promise would leak a client per case.
 */
const noted = (error: unknown) => console.error("waitUntil", error)
const ctx = {
  waitUntil: (promise: Promise<unknown>) => void promise.catch(noted),
} as ExecutionContext

/**
 * An environment with a database nothing listens on. Every case below is
 * refused before a statement is sent, and postgres.js connects lazily, so this
 * proves the refusal happens first: if one of them ever reached the database,
 * it would fail to connect rather than pass.
 */
const unreachable = {
  // No credentials in it, so the secret scan reads it as what it is. Nothing
  // listens on port 1 either way.
  HYPERDRIVE: { connectionString: "postgresql://127.0.0.1:1/none" },
  // Short on purpose: the secret scan reads any long quoted value after a
  // key-shaped name as a key, and it is right to.
  WORKOS_API_KEY: "unused",
  WORKOS_CLIENT_ID: "unused",
  WORKOS_COOKIE_PASSWORD: "x".repeat(32),
} as unknown as Env

const call = (path: string, init?: RequestInit) =>
  worker.fetch(new Request(`http://api.invalid${path}`, init), unreachable, ctx)

describe("routes that need no database", () => {
  it("answers an unknown path with the typed error envelope", async () => {
    const response = await call("/nope")
    expect(response.status).toBe(404)
    // R4: parsed rather than eyeballed, so a shape that drifts from §28.1
    // fails here rather than in whatever reads it.
    const body = ErrorEnvelope.parse(await response.json())
    expect(body.code).toBe("route.not_found")
  })

  it("refuses a read with no session", async () => {
    for (const path of ["/org", "/staff"]) {
      const response = await call(path)
      expect(response.status, path).toBe(401)
      expect(ErrorEnvelope.parse(await response.json()).code).toBe(
        "session.absent"
      )
    }
  })

  it("refuses a read whose session cookie is not one", async () => {
    // The seal is checked by the SDK and a tampered one comes back as
    // unauthenticated rather than as an exception, so this is a 401 and not a
    // 503. It is the case that would otherwise be a stack trace in the log.
    const response = await call("/org", {
      headers: { cookie: "wos-session=not-a-sealed-session" },
    })
    expect(response.status).toBe(401)
  })

  it("refuses the write with no session before it reads a body", async () => {
    const response = await call("/org", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    })
    expect(response.status).toBe(401)
  })

  it("has no route that takes an organisation from the caller", async () => {
    // The property, driven rather than asserted about the source: every
    // spelling of an org id in a query string still reaches the same refusal,
    // because nothing in the router reads one.
    for (const query of [
      "?org_id=10000001-0000-4000-8000-000000000000",
      "?organizationId=org_fixture_brightclean",
      "?organization_id=org_fixture_brightclean",
    ]) {
      const response = await call(`/org${query}`)
      expect(response.status, query).toBe(401)
    }
  })
})

describe.skipIf(!url)("the reads, on a live connection", () => {
  const kit = tenancy(url as string, { max: 2 })
  afterAll(() => kit.close())

  it("reads the org the id names and nothing else", async () => {
    const org = Org.parse(await readOrg(kit, brightclean.org.id as string))
    expect(org.slug).toBe("brightclean")
    // The wire shape carries no WorkOS organization id, and `strictObject`
    // is what enforces that rather than a comment.
    expect(Object.keys(org).sort()).toEqual([
      "created_at",
      "name",
      "org_id",
      "slug",
    ])
  })

  it("reads the staff directory in staff_code order", async () => {
    const directory = StaffDirectory.parse(
      await readStaffDirectory(kit, brightclean.org.id as string)
    )
    expect(directory.staff.length).toBe(brightclean.staff.length)
    const codes = directory.staff.map((member) => member.staff_code)
    expect(codes).toEqual([...codes].sort())
    for (const member of directory.staff) {
      expect(member.org_id).toBe(brightclean.org.id)
    }
  })

  it("answers an org with no staff with an empty list, not an error", async () => {
    const directory = await readStaffDirectory(kit, emptyco.org.id as string)
    expect(directory.staff).toEqual([])
  })
})

/**
 * The database half of signup, with the WorkOS calls stood in for.
 *
 * The stand-in is the whole point: creating an organization in a real WorkOS
 * environment leaves a resource behind, and every assertion worth making here
 * is about what Postgres ends up holding.
 */
describe.skipIf(!url)("the org writer, on a live connection", () => {
  const kit = tenancy(url as string, { max: 2 })

  const WORKOS_ORG = "org_probe_api_writer"
  const WORKOS_USER = "user_probe_api_writer"
  const WORKOS_MEMBERSHIP = "om_probe_api_writer"

  /**
   * A stand-in that behaves the way WorkOS actually behaves, which is the only
   * reason these cases mean anything.
   *
   * Measured against staging on 2026-08-29: `POST /organizations` ignores
   * `Idempotency-Key`. Two requests carrying an identical key answered 201
   * twice, with two different organization ids. So this hands back a new id
   * every time it is called, and a writer that leaned on the key to replay
   * fails here instead of in a signup.
   *
   * The memberships list is what does replay, so it answers from what has been
   * created, the way the real one does.
   */
  let calls = 0
  const created: { id: string; organizationId: string }[] = []
  const directory: Directory = {
    createOrganization: async () => {
      calls += 1
      return { id: `${WORKOS_ORG}_${calls}` }
    },
    listOrganizationMemberships: async () => ({ data: created.slice(0, 1) }),
    createOrganizationMembership: async ({ organizationId }) => {
      const membership = {
        id: `${WORKOS_MEMBERSHIP}_${created.length + 1}`,
        organizationId,
      }
      created.push(membership)
      return membership
    },
  }

  const input = {
    name: "Probe Cleaning Co. (fixture)",
    idempotencyKey: "probe-key",
    workosUserId: WORKOS_USER,
    email: "probe@api-writer.invalid",
    displayName: "Probe Owner",
  }

  afterAll(async () => {
    // The org and its membership go. The person does not: `users` has no delete
    // policy on purpose (§10.5 owns removing a human), so the probe row stays
    // and the next run exercises the branch where the person already exists,
    // which is also what a second business by the same owner does.
    const written = await resolveOrg(kit, {
      workosUserId: WORKOS_USER,
      workosOrganizationId: `${WORKOS_ORG}_1`,
    })
    if (written) {
      await kit.withOrg({ orgId: written }, async (db) => {
        // Reports before managers, and staff before the membership the owner
        // row points at.
        for (const code of ["DEV-001", "COS-001", "OWN-001"]) {
          await db.delete(staff).where(eq(staff.staffCode, code))
        }
        await db.delete(memberships).where(eq(memberships.orgId, written))
        await db.delete(orgs).where(eq(orgs.id, written))
      })
    }
    await kit.close()
  }, 60_000)

  it("creates the org and gives the caller the contract shape", async () => {
    const org = Org.parse(await createOrg(kit, directory, input))
    expect(org.name).toBe(input.name)
    // Derived from the name, suffixed with the org's own id, so it is unique
    // without a read and cannot be chosen by a caller.
    expect(org.slug).toBe(`probe-cleaning-co-fixture-${org.org_id.slice(0, 8)}`)
  })

  it("resolves that org from the pair the session carries", async () => {
    const resolved = await resolveOrg(kit, {
      workosUserId: WORKOS_USER,
      workosOrganizationId: `${WORKOS_ORG}_1`,
    })
    const org = await readOrg(kit, resolved as string)
    expect(org?.name).toBe(input.name)
  })

  it("replays rather than making a second tenant", async () => {
    const first = await resolveOrg(kit, {
      workosUserId: WORKOS_USER,
      workosOrganizationId: `${WORKOS_ORG}_1`,
    })
    const again = await createOrg(kit, directory, input)
    expect(again.org_id).toBe(first)
    // And no second organization was asked for. This is the assertion that
    // catches the real failure: the writer used to create one per attempt and
    // rely on the idempotency key to give the same one back, which WorkOS does
    // not do. The membership the owner already holds is what replays.
    expect(calls).toBe(1)
  })

  const writtenOrg = async () =>
    (await resolveOrg(kit, {
      workosUserId: WORKOS_USER,
      workosOrganizationId: `${WORKOS_ORG}_1`,
    })) as string

  const team = (orgId: string) =>
    kit.withOrg({ orgId }, (db) =>
      db
        .select({
          id: staff.id,
          code: staff.staffCode,
          name: staff.displayName,
          kind: staff.kind,
          userId: staff.userId,
          managerId: staff.managerId,
          status: staff.status,
        })
        .from(staff)
        .orderBy(asc(staff.staffCode))
    )

  it("gives the new org its owner, a Chief of Staff and a Developer", async () => {
    const orgId = await writtenOrg()
    const [person] = await kit.withOrg(
      { orgId, workosUserId: WORKOS_USER },
      (db) =>
        db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.workosUserId, WORKOS_USER))
    )
    const rows = await team(orgId)
    expect(rows.map((row) => row.code)).toEqual([
      "COS-001",
      "DEV-001",
      "OWN-001",
    ])
    const [chief, developer, owner] = rows
    expect(owner).toMatchObject({
      name: input.displayName,
      kind: "human",
      userId: person?.id,
      managerId: null,
    })
    expect(chief).toMatchObject({ name: "Maya", kind: "agent" })
    expect(chief?.managerId).toBe(owner?.id)
    expect(developer).toMatchObject({ name: "Alex", kind: "agent" })
    expect(developer?.managerId).toBe(chief?.id)
    for (const row of rows) expect(row.status).toBe("active")
  })

  it("is found by the lookup the orchestrator runs before a build", async () => {
    // The where clause of `createAssignment` in apps/orchestrator/src/app.ts,
    // copied because an app cannot import another. A build for this org would
    // otherwise stop at 409 `staff.developer_missing`.
    const orgId = await writtenOrg()
    const codes = await kit.withOrg({ orgId }, (db) =>
      db
        .select({ code: staff.staffCode })
        .from(staff)
        .where(sql`${staff.staffCode} in ('DEV-001', 'COS-001')`)
    )
    expect(codes.map((row) => row.code).sort()).toEqual(["COS-001", "DEV-001"])
  })

  it("adds nobody when the team is ensured again", async () => {
    const orgId = await writtenOrg()
    const before = await team(orgId)
    const owner = before.find((row) => row.code === "OWN-001")
    await kit.withOrg({ orgId }, (db) =>
      ensureStartingTeam(db, {
        orgId,
        userId: owner?.userId as string,
        ownerName: "Someone Else",
      })
    )
    expect(await team(orgId)).toEqual(before)
  })

  it("leaves every other org's staff where it was", async () => {
    const orgId = await writtenOrg()
    const ours = new Set((await team(orgId)).map((row) => row.id))
    const theirs = await readStaffDirectory(kit, brightclean.org.id as string)
    expect(theirs.staff.length).toBe(brightclean.staff.length)
    for (const member of theirs.staff) {
      expect(ours.has(member.staff_id)).toBe(false)
    }
  })
})
