import { ErrorEnvelope } from "@workspace/contracts"
import { eq, memberships, resolveOrg, sql, tenancy, users } from "@workspace/db"
import { clearOrgs, type Tx } from "@workspace/db/fixtures/seed"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type Accounts, deleteAccount, tombstone } from "../src/account.ts"
import worker from "../src/index.ts"
import { createOrg, type Directory, EmailTaken } from "../src/org.ts"
import { cookieHeader, env, stubJwksFetch } from "./sealed-session.ts"

/**
 * Deleting an owner's account (ADR-035), and signing up again with the same
 * email afterwards. WorkOS is a stand-in that answers the way the real one
 * does for a thing already gone: a 404.
 */

const url = process.env.DATABASE_URL
const noted = (error: unknown) => console.error("waitUntil", error)
const ctx = {
  waitUntil: (promise: Promise<unknown>) => void promise.catch(noted),
} as ExecutionContext

/**
 * One stub for the whole file, because the WorkOS client is made once per
 * isolate and keeps the `fetch` it was made with. It answers the JWKS, and
 * hands anything else to `workosApi`, which refuses unless a case sets it.
 */
const realFetch = globalThis.fetch
const jwks = stubJwksFetch()
let workosApi = (request: Request): Promise<Response> => {
  throw new Error(`the tests do not reach the network: ${request.url}`)
}
beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    return new URL(request.url).pathname.startsWith("/sso/jwks/")
      ? jwks(input, init)
      : workosApi(request)
  }) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
})

describe("the route, before the database", () => {
  const remove = (headers: Record<string, string> = {}) =>
    worker.fetch(
      new Request("http://api.invalid/account", { method: "DELETE", headers }),
      env("postgresql://127.0.0.1:1/none"),
      ctx
    )

  it("refuses a request with no session", async () => {
    const response = await remove()
    expect(response.status).toBe(401)
  })

  it("refuses a request with no idempotency key", async () => {
    const response = await remove(
      await cookieHeader({ sub: "user_probe_account", org_id: "org_probe" })
    )
    expect(response.status).toBe(400)
    expect(ErrorEnvelope.parse(await response.json()).code).toBe(
      "idempotency_key.missing"
    )
  })
})

const notFound = () => Object.assign(new Error("not found"), { status: 404 })

/** WorkOS as far as deletion sees it: who is in which org, and what is gone. */
function fakeWorkos(members: Record<string, string[]>) {
  const gone: string[] = []
  let failures = 0
  const accounts: Accounts = {
    listOrganizationMemberships: async ({ organizationId }) => {
      if (gone.includes(organizationId)) throw notFound()
      return {
        data: (members[organizationId] ?? []).map((userId) => ({ userId })),
      }
    },
    deleteOrganization: async (id) => {
      if (gone.includes(id)) throw notFound()
      gone.push(id)
    },
    deleteUser: async (id) => {
      if (failures > 0) {
        failures -= 1
        throw Object.assign(new Error("unavailable"), { status: 503 })
      }
      if (gone.includes(id)) throw notFound()
      gone.push(id)
    },
  }
  const failNextUserDelete = () => {
    failures += 1
  }
  return { accounts, gone, failNextUserDelete }
}

describe.skipIf(!url)("deleting an account, on a live connection", () => {
  const kit = tenancy(url as string, { max: 2 })
  const admin = postgres(url as string, { max: 1 })
  const run = crypto.randomUUID().slice(0, 8)
  const created: string[] = []
  let organizations = 0

  /** Signs a person up through `createOrg`, as `POST /org` does. */
  const signup = async (
    tag: string,
    email = `${tag}-${run}@account.invalid`
  ) => {
    organizations += 1
    const workosUserId = `user_probe_account_${tag}_${run}`
    const workosOrganizationId = `org_probe_account_${run}_${organizations}`
    const directory: Directory = {
      createOrganization: async () => ({ id: workosOrganizationId }),
      listOrganizationMemberships: async () => ({ data: [] }),
      createOrganizationMembership: async () => ({
        id: `om_probe_account_${run}_${organizations}`,
      }),
    }
    const org = await createOrg(kit, directory, {
      name: `Probe ${tag} Cleaning Co. (fixture)`,
      idempotencyKey: "probe-key",
      workosUserId,
      email,
      displayName: "Probe Owner",
    })
    created.push(org.org_id)
    const session = {
      workosUserId,
      workosOrganizationId,
      sessionId: `session_${tag}`,
      impersonated: false,
      email,
      name: "Probe Owner",
    }
    return { orgId: org.org_id, session, email }
  }

  const person = async (workosUserId: string) => {
    const [row] = await admin<{ id: string; email: string; name: string }[]>`
      select id, email, name from users where workos_user_id = ${workosUserId}`
    return row
  }

  const logged = async (orgId: string) => {
    const [row] = await admin<{ count: number }[]>`
      select count(*)::int from events
      where org_id = ${orgId} and type = 'account.deleted'`
    return row?.count
  }

  afterAll(async () => {
    if (created.length > 0) {
      await kit.withOrg({ orgId: created[0] as string }, async (db) => {
        await db.execute(sql`reset role`)
        await clearOrgs(db as unknown as Tx, created, [])
      })
    }
    await admin.end()
    await kit.close()
  }, 60_000)

  it("frees the email, ends the membership and removes the WorkOS identity", async () => {
    const { orgId, session, email } = await signup("sole")
    const workos = fakeWorkos({
      [session.workosOrganizationId]: [session.workosUserId],
    })

    expect(await deleteAccount(kit, workos.accounts, session)).toBe("deleted")

    const row = await person(session.workosUserId)
    expect(row?.email).toBe(tombstone(row?.id as string))
    expect(row?.name).toBeNull()
    const [membership] = await admin<{ status: string }[]>`
      select status from memberships where org_id = ${orgId}`
    expect(membership?.status).toBe("inactive")
    expect(await resolveOrg(kit, session)).toBeNull()
    expect(await logged(orgId)).toBe(1)
    expect(workos.gone).toEqual([
      session.workosOrganizationId,
      session.workosUserId,
    ])

    // A second call finds everything gone and still succeeds.
    expect(await deleteAccount(kit, workos.accounts, session)).toBe("deleted")
    expect(await logged(orgId)).toBe(1)

    // The same email signs up again under a new WorkOS user.
    const again = await signup("again", email)
    expect(again.orgId).not.toBe(orgId)
    expect((await person(again.session.workosUserId))?.email).toBe(email)
  })

  it("finishes on a second call when WorkOS failed after the database", async () => {
    const { orgId, session } = await signup("retry")
    const workos = fakeWorkos({
      [session.workosOrganizationId]: [session.workosUserId],
    })
    workos.failNextUserDelete()

    await expect(deleteAccount(kit, workos.accounts, session)).rejects.toThrow(
      "unavailable"
    )
    expect(await resolveOrg(kit, session)).toBeNull()
    expect(workos.gone).toEqual([session.workosOrganizationId])

    expect(await deleteAccount(kit, workos.accounts, session)).toBe("deleted")
    expect(workos.gone).toEqual([
      session.workosOrganizationId,
      session.workosUserId,
    ])
    expect(await logged(orgId)).toBe(1)
  })

  it("refuses while another member is active, and refuses that member", async () => {
    const { orgId, session, email } = await signup("shared")
    const other = `user_probe_account_other_${run}`
    await kit.withOrg({ orgId, workosUserId: other }, async (db) => {
      await db
        .insert(users)
        .values({ workosUserId: other, email: `other-${run}@account.invalid` })
      const [row] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.workosUserId, other))
      await db.insert(memberships).values({
        orgId,
        userId: row?.id as string,
        workosMembershipId: `om_probe_account_other_${run}`,
        role: "member",
        status: "active",
      })
    })
    const workos = fakeWorkos({})

    expect(await deleteAccount(kit, workos.accounts, session)).toBe(
      "other_members"
    )
    expect(
      await deleteAccount(kit, workos.accounts, {
        ...session,
        workosUserId: other,
      })
    ).toBe("not_owner")
    expect((await person(session.workosUserId))?.email).toBe(email)
    expect(await resolveOrg(kit, session)).toBe(orgId)
    expect(await logged(orgId)).toBe(0)
    expect(workos.gone).toEqual([])
  })

  it("refuses a session with no org it resolves and no deleted row", async () => {
    const workos = fakeWorkos({})
    const outcome = await deleteAccount(kit, workos.accounts, {
      workosUserId: `user_probe_account_stranger_${run}`,
      workosOrganizationId: "org_probe_account_stranger",
      sessionId: "session_stranger",
      impersonated: false,
      email: "stranger@account.invalid",
      name: null,
    })
    expect(outcome).toBe("unresolved")
    expect(workos.gone).toEqual([])
  })

  it("answers a signup whose email another row holds before calling WorkOS", async () => {
    const { email } = await signup("held")
    let asked = 0
    const directory: Directory = {
      createOrganization: async () => {
        asked += 1
        return { id: "org_probe_account_never" }
      },
      listOrganizationMemberships: async () => {
        asked += 1
        return { data: [] }
      },
      createOrganizationMembership: async () => {
        asked += 1
        return { id: "om_probe_account_never" }
      },
    }
    await expect(
      createOrg(kit, directory, {
        name: "Probe Held Cleaning Co. (fixture)",
        idempotencyKey: "probe-key",
        workosUserId: `user_probe_account_newcomer_${run}`,
        email,
        displayName: null,
      })
    ).rejects.toBeInstanceOf(EmailTaken)
    expect(asked).toBe(0)
  })

  it("deletes through the route with a real session and the SDK's own calls", async () => {
    const { orgId, session } = await signup("route")
    const asked: string[] = []
    workosApi = async (request) => {
      const { pathname } = new URL(request.url)
      asked.push(`${request.method} ${pathname}`)
      if (request.method === "GET") {
        return Response.json({
          object: "list",
          data: [
            {
              object: "organization_membership",
              id: "om_probe_route",
              user_id: session.workosUserId,
              organization_id: session.workosOrganizationId,
              status: "active",
              role: { slug: "owner" },
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
          list_metadata: { before: null, after: null },
        })
      }
      return new Response(null, { status: 202 })
    }

    const headers = {
      ...(await cookieHeader({
        sub: session.workosUserId,
        org_id: session.workosOrganizationId,
      })),
      "idempotency-key": "delete-account",
    }
    const response = await worker.fetch(
      new Request("http://api.invalid/account", {
        method: "DELETE",
        headers,
      }),
      env(url as string),
      ctx
    )
    expect(response.status).toBe(204)
    expect(asked).toEqual([
      "GET /user_management/organization_memberships",
      `DELETE /organizations/${session.workosOrganizationId}`,
      `DELETE /user_management/users/${session.workosUserId}`,
    ])
    expect(await resolveOrg(kit, session)).toBeNull()
    expect(await logged(orgId)).toBe(1)
  })
})
