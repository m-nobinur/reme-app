import { ErrorEnvelope, OWNER_BRIDGE_HEADERS } from "@workspace/contracts"
import {
  eq,
  jobRuns,
  memberships,
  orgOpen,
  resolveOrg,
  scheduledJobs,
  sql,
  tenancy,
  users,
} from "@workspace/db"
import { clearOrgs, type Tx } from "@workspace/db/fixtures/seed"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  type Accounts,
  deleteAccount,
  type Objects,
  removeObjects,
  type Takedown,
  tombstone,
} from "../src/account.ts"
import worker from "../src/index.ts"
import { createOrg, type Directory, EmailTaken } from "../src/org.ts"
import { WORKOS_TIMEOUT_MS } from "../src/session.ts"
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

/**
 * The sites bucket in memory, two keys a page. The cursor is the last key
 * returned, as R2's is a position in key order, so deleting a page before
 * asking for the next one skips nothing.
 */
function bucket(initial: string[]) {
  const held = new Set(initial)
  const sites: Objects = {
    list: async ({ prefix, cursor }) => {
      const after = [...held]
        .filter((k) => k.startsWith(prefix) && (!cursor || k > cursor))
        .sort((a, b) => (a < b ? -1 : 1)) // R2 orders keys by code unit
      const page = after.slice(0, 2)
      const truncated = after.length > 2
      return {
        objects: page.map((key) => ({ key })),
        truncated,
        cursor: truncated ? page.at(-1) : undefined,
      }
    },
    delete: async (keys) => {
      for (const key of [keys].flat()) held.delete(key)
    },
  }
  return { sites, held }
}

/** Every kind of object an org owns. */
const owned = (org: string) => [
  `uploads/${org}/a`,
  `uploads/${org}/b`,
  `uploads/${org}/c`,
  `generated/${org}/a`,
  `sites/${org}/rev1/dist/index.html`,
  `sites/${org}/rev1/manifest.json`,
  `sites/${org}/rev2/dist/index.html`,
  `sites/${org}/checkpoints/asg.tar.zst`,
  `sandboxes/${org}`,
]

describe("removing an org's R2 objects", () => {
  const org = "0b7a5d5e-1111-4000-8000-000000000001"
  const other = "0b7a5d5e-1111-4000-8000-000000000002"
  // Starts with the first org's id, so a prefix without its slash would match it.
  const longer = `${org}0`

  it("deletes every page of the org's objects and nothing of another org's", async () => {
    const { sites, held } = bucket([
      ...owned(org),
      ...owned(other),
      ...owned(longer),
    ])
    await removeObjects(sites, org)
    expect([...held].sort()).toEqual([...owned(other), ...owned(longer)].sort())
  })

  it("finishes on a retry after a partial run, and repeats as a no-op", async () => {
    const { sites, held } = bucket([...owned(org), ...owned(other)])
    let calls = 0
    const flaky: Objects = {
      list: sites.list,
      delete: async (keys) => {
        if (++calls === 2) throw new Error("R2 answered 500")
        await sites.delete(keys)
      },
    }
    await expect(removeObjects(flaky, org)).rejects.toThrow("R2 answered 500")
    expect(held.size).toBeGreaterThan(owned(other).length)
    await removeObjects(flaky, org)
    await removeObjects(sites, org)
    expect([...held].sort()).toEqual(owned(other).sort())
  })
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

/**
 * The orchestrator's takedown as deletion sees it: which orgs it was asked
 * for, in order, and how many calls to fail first.
 */
function fakeTakedown(calls: string[] = []) {
  let failures = 0
  const takedown: Takedown = async (orgId) => {
    calls.push(`takedown ${orgId}`)
    if (failures > 0) {
      failures -= 1
      throw new Error("orchestrator unavailable")
    }
  }
  return {
    takedown,
    calls,
    failNext: () => {
      failures += 1
    },
  }
}

/** WorkOS as far as deletion sees it: who is in which org, and what is gone. */
function fakeWorkos(members: Record<string, string[]>, calls: string[] = []) {
  const gone: string[] = []
  let failures = 0
  const accounts: Accounts = {
    listOrganizationMemberships: async ({ organizationId }) => {
      calls.push("workos list")
      if (gone.includes(organizationId)) throw notFound()
      return {
        data: (members[organizationId] ?? []).map((userId) => ({ userId })),
      }
    },
    deleteOrganization: async (id) => {
      calls.push("workos delete organization")
      if (gone.includes(id)) throw notFound()
      gone.push(id)
    },
    deleteUser: async (id) => {
      calls.push("workos delete user")
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
    const jobId = crypto.randomUUID()
    await kit.withOrg({ orgId }, async (db) => {
      await db.insert(scheduledJobs).values({
        id: jobId,
        orgId,
        kind: "heartbeat",
        rule: "0 */4 * * *",
        nextRunAt: new Date(),
      })
      await db
        .insert(jobRuns)
        .values({ jobId, orgId, runAt: new Date(0), outcome: "ok" })
    })
    const workos = fakeWorkos({
      [session.workosOrganizationId]: [session.workosUserId],
    })

    expect(
      await deleteAccount(
        kit,
        workos.accounts,
        fakeTakedown().takedown,
        session
      )
    ).toBe("deleted")

    const row = await person(session.workosUserId)
    expect(row?.email).toBe(tombstone(row?.id as string))
    expect(row?.name).toBeNull()
    const [membership] = await admin<{ status: string }[]>`
      select status from memberships where org_id = ${orgId}`
    expect(membership?.status).toBe("inactive")
    expect(await resolveOrg(kit, session)).toBeNull()
    expect(await logged(orgId)).toBe(1)
    // Nothing is left to run for the org.
    const [jobs] = await admin<{ jobs: number; runs: number }[]>`
      select (select count(*)::int from scheduled_jobs where org_id = ${orgId}) as jobs,
        (select count(*)::int from job_runs where org_id = ${orgId}) as runs`
    expect(jobs).toEqual({ jobs: 0, runs: 0 })
    expect(workos.gone).toEqual([
      session.workosOrganizationId,
      session.workosUserId,
    ])

    // A second call finds everything gone and still succeeds.
    expect(
      await deleteAccount(
        kit,
        workos.accounts,
        fakeTakedown().takedown,
        session
      )
    ).toBe("deleted")
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

    await expect(
      deleteAccount(kit, workos.accounts, fakeTakedown().takedown, session)
    ).rejects.toThrow("unavailable")
    expect(await resolveOrg(kit, session)).toBeNull()
    expect(workos.gone).toEqual([session.workosOrganizationId])

    expect(
      await deleteAccount(
        kit,
        workos.accounts,
        fakeTakedown().takedown,
        session
      )
    ).toBe("deleted")
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
    const down = fakeTakedown()

    expect(
      await deleteAccount(kit, workos.accounts, down.takedown, session)
    ).toBe("other_members")
    expect(
      await deleteAccount(kit, workos.accounts, down.takedown, {
        ...session,
        workosUserId: other,
      })
    ).toBe("not_owner")
    expect((await person(session.workosUserId))?.email).toBe(email)
    expect(await resolveOrg(kit, session)).toBe(orgId)
    expect(await logged(orgId)).toBe(0)
    expect(workos.gone).toEqual([])
    // A refusal takes nothing down.
    expect(down.calls).toEqual([])
    expect(await kit.withOrg({ orgId }, orgOpen)).toBe(true)
  })

  it("takes the site down once the org reads closed, before WorkOS and while the org still resolves", async () => {
    const { orgId, session } = await signup("order")
    const calls: string[] = []
    const workos = fakeWorkos(
      { [session.workosOrganizationId]: [session.workosUserId] },
      calls
    )
    const seen: { open: boolean; resolves: string | null }[] = []
    const takedown: Takedown = async (id) => {
      calls.push(`takedown ${id}`)
      seen.push({
        open: await kit.withOrg({ orgId: id }, orgOpen),
        resolves: await resolveOrg(kit, session),
      })
    }

    expect(await deleteAccount(kit, workos.accounts, takedown, session)).toBe(
      "deleted"
    )
    expect(calls).toEqual([
      `takedown ${orgId}`,
      "workos list",
      "workos delete organization",
      "workos delete user",
    ])
    // Closed to the router and the publisher, still the owner's to finish.
    expect(seen).toEqual([{ open: false, resolves: orgId }])
    expect(await kit.withOrg({ orgId }, orgOpen)).toBe(false)
  })

  it("fails when the takedown fails, with nothing gone at WorkOS, and a retry finishes", async () => {
    const { orgId, session } = await signup("takedown")
    const calls: string[] = []
    const workos = fakeWorkos(
      { [session.workosOrganizationId]: [session.workosUserId] },
      calls
    )
    const down = fakeTakedown(calls)
    down.failNext()

    await expect(
      deleteAccount(kit, workos.accounts, down.takedown, session)
    ).rejects.toThrow("orchestrator unavailable")
    expect(calls).toEqual([`takedown ${orgId}`])
    expect(workos.gone).toEqual([])
    // The org still resolves, so the retry can take the site down again.
    expect(await resolveOrg(kit, session)).toBe(orgId)
    expect(await logged(orgId)).toBe(0)

    expect(
      await deleteAccount(kit, workos.accounts, down.takedown, session)
    ).toBe("deleted")
    expect(calls.filter((c) => c.startsWith("takedown"))).toEqual([
      `takedown ${orgId}`,
      `takedown ${orgId}`,
    ])
    expect(workos.gone).toEqual([
      session.workosOrganizationId,
      session.workosUserId,
    ])
    expect(await resolveOrg(kit, session)).toBeNull()
    expect(await logged(orgId)).toBe(1)
  })

  it("refuses a session with no org it resolves and no deleted row", async () => {
    const workos = fakeWorkos({})
    const outcome = await deleteAccount(
      kit,
      workos.accounts,
      fakeTakedown().takedown,
      {
        workosUserId: `user_probe_account_stranger_${run}`,
        workosOrganizationId: "org_probe_account_stranger",
        sessionId: "session_stranger",
        impersonated: false,
        email: "stranger@account.invalid",
        name: null,
      }
    )
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

  it("deletes through the route with a real session, the bridge and the SDK's own calls", async () => {
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

    // The orchestrator fails the first takedown and takes the second.
    let takedown = 503
    const orchestrator = {
      fetch: async (request: Request) => {
        const { pathname } = new URL(request.url)
        const org = request.headers.get(OWNER_BRIDGE_HEADERS.orgId)
        asked.push(`${request.method} orchestrator ${pathname} ${org}`)
        return takedown === 204
          ? new Response(null, { status: 204 })
          : Response.json({}, { status: takedown })
      },
    }
    const headers = {
      ...(await cookieHeader({
        sub: session.workosUserId,
        org_id: session.workosOrganizationId,
      })),
      "idempotency-key": "delete-account",
    }
    const objects = bucket([...owned(orgId), ...owned(crypto.randomUUID())])
    const remove = () =>
      worker.fetch(
        new Request("http://api.invalid/account", {
          method: "DELETE",
          headers,
        }),
        {
          ...env(url as string),
          ORCHESTRATOR: orchestrator,
          SITES: objects.sites,
        } as unknown as Env,
        ctx
      )
    const bridged = `POST orchestrator /assignments/site/takedown ${orgId}`

    const failed = await remove()
    expect(failed.status).toBe(503)
    expect(asked).toEqual([bridged])
    expect(await resolveOrg(kit, session)).toBe(orgId)
    // A failed takedown deletes nothing.
    expect(objects.held.size).toBe(owned(orgId).length * 2)

    asked.length = 0
    takedown = 204
    const response = await remove()
    expect(response.status).toBe(204)
    expect(asked).toEqual([
      bridged,
      "GET /user_management/organization_memberships",
      `DELETE /organizations/${session.workosOrganizationId}`,
      `DELETE /user_management/users/${session.workosUserId}`,
    ])
    expect(await resolveOrg(kit, session)).toBeNull()
    expect(await logged(orgId)).toBe(1)
    expect([...objects.held].some((k) => k.includes(orgId))).toBe(false)
    expect(objects.held.size).toBe(owned(orgId).length)
  })

  /**
   * The route's answer to a WorkOS that never answers and ignores the abort,
   * the worst a vendor can do. `outbound.test.ts` holds the bound to the
   * millisecond; this holds that the route waits for it and answers 503.
   */
  const timed = async (call: () => Promise<Response>) => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined)
    workosApi = vi.fn(() => new Promise<Response>(() => undefined))
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      let answered = false
      const answer = call().finally(() => {
        answered = true
      })
      // `waitFor` moves the fake clock as it polls, and the database driver
      // connects on a timer.
      await vi.waitFor(() => expect(workosApi).toHaveBeenCalled())
      expect(answered).toBe(false)
      await vi.advanceTimersByTimeAsync(WORKOS_TIMEOUT_MS)
      const response = await answer
      expect(response.status).toBe(503)
      expect(ErrorEnvelope.parse(await response.json()).code).toBe(
        "workos.timeout"
      )
    } finally {
      vi.useRealTimers()
      quiet.mockRestore()
    }
  }

  it("answers a stalled WorkOS on delete with 503 at the bound, and a retry finishes", async () => {
    const { session } = await signup("stall")
    const orchestrator = {
      fetch: async () => new Response(null, { status: 204 }),
    }
    const remove = async () =>
      worker.fetch(
        new Request("http://api.invalid/account", {
          method: "DELETE",
          headers: {
            ...(await cookieHeader({
              sub: session.workosUserId,
              org_id: session.workosOrganizationId,
            })),
            "idempotency-key": "delete-stalled",
          },
        }),
        {
          ...env(url as string),
          ORCHESTRATOR: orchestrator,
          SITES: bucket([]).sites,
        } as unknown as Env,
        ctx
      )

    await timed(remove)

    workosApi = async (request) =>
      request.method === "GET"
        ? Response.json({
            object: "list",
            data: [],
            list_metadata: { before: null, after: null },
          })
        : new Response(null, { status: 202 })
    expect((await remove()).status).toBe(204)
  })

  it("answers a stalled WorkOS on signup with 503 at the bound", async () => {
    const workosUserId = `user_probe_account_signup_stall_${run}`
    await timed(async () =>
      worker.fetch(
        new Request("http://api.invalid/org", {
          method: "POST",
          headers: {
            ...(await cookieHeader({ sub: workosUserId })),
            "idempotency-key": "signup-stalled",
            "content-type": "application/json",
          },
          body: JSON.stringify({ name: "Probe Stall Cleaning Co. (fixture)" }),
        }),
        env(url as string),
        ctx
      )
    )
  })
})
