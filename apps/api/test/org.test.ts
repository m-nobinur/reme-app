import { ErrorEnvelope, Org, StaffDirectory } from "@workspace/contracts"
import {
  asc,
  conversationMessages,
  conversations,
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
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
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

  /**
   * The test's own connection, as the connecting role and outside `withOrg`,
   * so it sees every org's rows and can look for what signup wrote anywhere.
   */
  const admin = postgres(url as string, { max: 1 })

  /**
   * An org this suite wrote, gone: its onboarding conversation first, then
   * staff whatever the codes, then the membership an owner row points at,
   * then the org. A run that failed halfway leaves nothing the next run
   * trips on.
   */
  const drop = (dropped: string) =>
    kit.withOrg({ orgId: dropped }, async (db) => {
      await db.delete(conversationMessages)
      await db.delete(conversations)
      for (;;) {
        const gone = await db
          .delete(staff)
          .where(
            sql`${staff.id} not in (select ${staff.managerId} from ${staff} where ${staff.managerId} is not null)`
          )
        if ((gone as unknown as { count: number }).count === 0) break
      }
      await db.delete(memberships).where(eq(memberships.orgId, dropped))
      await db.delete(orgs).where(eq(orgs.id, dropped))
    })

  let org: Org
  let orgId: string
  const others: string[] = []

  beforeAll(async () => {
    org = Org.parse(await createOrg(kit, directory, input))
    const resolved = await resolveOrg(kit, {
      workosUserId: WORKOS_USER,
      workosOrganizationId: `${WORKOS_ORG}_1`,
    })
    if (!resolved) throw new Error("signup wrote no org the session resolves")
    orgId = resolved
  }, 60_000)

  afterAll(async () => {
    // The org and its membership go. The person does not: `users` has no delete
    // policy on purpose (§10.5 owns removing a human), so the probe row stays
    // and the next run exercises the branch where the person already exists,
    // which is also what a second business by the same owner does.
    const written = await resolveOrg(kit, {
      workosUserId: WORKOS_USER,
      workosOrganizationId: `${WORKOS_ORG}_1`,
    })
    for (const id of [...others, ...(written ? [written] : [])]) await drop(id)
    await admin.end()
    await kit.close()
  }, 60_000)

  it("creates the org and gives the caller the contract shape", () => {
    expect(org.name).toBe(input.name)
    // Derived from the name, suffixed with the org's own id, so it is unique
    // without a read and cannot be chosen by a caller.
    expect(org.slug).toBe(`probe-cleaning-co-fixture-${org.org_id.slice(0, 8)}`)
  })

  it("resolves that org from the pair the session carries", async () => {
    expect((await readOrg(kit, orgId))?.name).toBe(input.name)
  })

  it("replays rather than making a second tenant", async () => {
    const again = await createOrg(kit, directory, input)
    expect(again.org_id).toBe(orgId)
    // And no second organization was asked for. This is the assertion that
    // catches the real failure: the writer used to create one per attempt and
    // rely on the idempotency key to give the same one back, which WorkOS does
    // not do. The membership the owner already holds is what replays.
    expect(calls).toBe(1)
  })

  it("lands the owner in onboarding, asked for the business name", async () => {
    const [held, rows] = await kit.withOrg({ orgId }, (db) =>
      Promise.all([
        db.select().from(conversations),
        db.select().from(conversationMessages),
      ])
    )
    // One of each, the replay above included.
    expect(held.map((c) => c.kind)).toEqual(["onboarding"])
    expect(rows).toHaveLength(1)
    const [first] = rows
    expect(first?.parentId).toBeNull()
    expect(first?.content).toEqual({
      role: "assistant",
      parts: [
        { type: "step-start" },
        {
          type: "tool-ask_fact",
          toolCallId: expect.any(String),
          state: "input-available",
          input: {
            key: "business.name",
            skippable: false,
            prefill: { name: input.name },
          },
        },
      ],
    })
  })

  const person = async () => {
    const [row] = await kit.withOrg(
      { orgId, workosUserId: WORKOS_USER },
      (db) =>
        db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.workosUserId, WORKOS_USER))
    )
    return row?.id as string
  }

  const team = (id: string) =>
    kit.withOrg({ orgId: id }, (db) =>
      db
        .select({
          id: staff.id,
          orgId: staff.orgId,
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
      userId: await person(),
      managerId: null,
    })
    expect(chief).toMatchObject({ name: "Maya", kind: "agent" })
    expect(chief?.managerId).toBe(owner?.id)
    expect(developer).toMatchObject({ name: "Alex", kind: "agent" })
    expect(developer?.managerId).toBe(chief?.id)
    for (const row of rows) expect(row.status).toBe("active")
  })

  it("writes exactly three staff rows, all in the new org", async () => {
    const rows = await team(orgId)
    expect(rows.length).toBe(3)
    for (const row of rows) expect(row.orgId).toBe(orgId)
    // Nothing elsewhere names the new person or the new rows. Read by what
    // links to this signup rather than by counting whole orgs, because other
    // suites write staff into this database while this one runs.
    const ids = rows.map((row) => row.id)
    const [stray] = await admin<{ n: number }[]>`
      select count(*)::int as n from staff
      where org_id <> ${orgId}
        and (user_id = ${await person()}
          or id = any(${ids}::uuid[])
          or manager_id = any(${ids}::uuid[]))`
    expect(stray?.n).toBe(0)
  })

  it("adds nobody when the team is ensured again", async () => {
    const was = await team(orgId)
    await kit.withOrg({ orgId }, async (db) =>
      ensureStartingTeam(db, {
        orgId,
        userId: await person(),
        ownerName: "Someone Else",
      })
    )
    expect(await team(orgId)).toEqual(was)
  })

  it("puts the team under a root that has another code", async () => {
    // An org made before this, whose owner row is not OWN-001. The owner insert
    // meets the one-root index rather than the code, and has to stand aside
    // rather than fail the call.
    const other = crypto.randomUUID()
    others.push(other)
    const userId = await person()
    await kit.withOrg({ orgId: other }, async (db) => {
      await db.insert(orgs).values({
        id: other,
        slug: `older-${other.slice(0, 8)}`,
        name: "Older Cleaning Co. (fixture)",
      })
      await db.insert(memberships).values({
        orgId: other,
        userId,
        workosMembershipId: `om_probe_older_${other}`,
        role: "owner",
        status: "active",
      })
      await db.insert(staff).values({
        orgId: other,
        staffCode: "HUM-001",
        displayName: "Older Owner",
        kind: "human",
        userId,
        status: "active",
      })
      await ensureStartingTeam(db, {
        orgId: other,
        userId,
        ownerName: "Older Owner",
      })
    })
    const rows = await team(other)
    expect(rows.map((row) => row.code)).toEqual([
      "COS-001",
      "DEV-001",
      "HUM-001",
    ])
    const [chief, developer, root] = rows
    expect(chief?.managerId).toBe(root?.id)
    expect(developer?.managerId).toBe(chief?.id)
  })
})
