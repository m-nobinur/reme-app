import { resolveOrg, tenancy } from "@workspace/db"
import { clearOwner } from "@workspace/db/fixtures/seed"
import { afterAll, describe, expect, it } from "vitest"
import {
  appOn,
  deleteOwner,
  devOwner,
  ensureOwner,
  membershipRefusal,
  removeOwner,
  retireSession,
  STAGING_CLIENT_ID,
  sessionStatus,
  stagingRefusal,
  startPlan,
  // @ts-expect-error plain ESM, deliberately runnable without a build
} from "../scripts/dev-owner.mjs"
import { createOrg, type Directory, EmailTaken } from "../src/org.ts"
import {
  COOKIE_PASSWORD,
  OTHER_PASSWORD,
  sessionCookie,
} from "./sealed-session"

/**
 * The branches of `pnpm dev:session` that decide what exists in WorkOS. The
 * stand-in keeps users and memberships in memory and refuses a second user on
 * one address, the way WorkOS does, so "twice makes one" is a count of what it
 * holds rather than of the calls made.
 */
function fakeWorkos() {
  const users = new Map<string, { id: string; email: string }>()
  const memberships: {
    userId: string
    organizationId: string
    organizationName: string
  }[] = []
  const deletedOrgs: string[] = []
  const passwords: string[] = []
  const createdWith: Record<string, unknown>[] = []
  const revoked: string[] = []
  let next = 0
  return {
    users,
    memberships,
    deletedOrgs,
    passwords,
    createdWith,
    revoked,
    userManagement: {
      listUsers: async ({ email }: { email: string }) => ({
        data: [...users.values()].filter((u) => u.email === email),
      }),
      createUser: async (input: { email: string; password: string }) => {
        createdWith.push(input)
        if ([...users.values()].some((u) => u.email === input.email)) {
          throw new Error("email already in use")
        }
        next += 1
        const user = { id: `user_${next}`, email: input.email }
        users.set(user.id, user)
        passwords.push(input.password)
        return user
      },
      updateUser: async ({ password }: { password: string }) => {
        passwords.push(password)
      },
      deleteUser: async (id: string) => {
        users.delete(id)
      },
      listOrganizationMemberships: async ({ userId }: { userId: string }) => ({
        data: memberships.filter((m) => m.userId === userId),
      }),
      revokeSession: async ({ sessionId }: { sessionId: string }) => {
        if (revoked.includes(sessionId)) {
          throw Object.assign(new Error("already revoked"), { status: 400 })
        }
        revoked.push(sessionId)
      },
    },
    organizations: {
      deleteOrganization: async (id: string) => {
        deletedOrgs.push(id)
      },
    },
  }
}

describe("the staging guard", () => {
  const answering = (status: number, body: unknown) =>
    (async () => Response.json(body, { status })) as typeof fetch

  it("refuses any client id but staging's before calling WorkOS", async () => {
    let called = false
    const recorded = (async () => {
      called = true
      return Response.json({ error: "invalid_grant" }, { status: 400 })
    }) as typeof fetch
    const refusal = await stagingRefusal(
      { clientId: "client_01M0WWHMK5RP961JNYJH00YWZV", apiKey: "key" },
      recorded
    )
    expect(refusal).toContain("WORKOS_CLIENT_ID")
    expect(called).toBe(false)
  })

  it("refuses a key WorkOS places in another environment", async () => {
    const refusal = await stagingRefusal(
      { clientId: STAGING_CLIENT_ID, apiKey: "key" },
      answering(400, { error: "invalid_client" })
    )
    expect(refusal).toContain("invalid_client")
  })

  it("refuses when WorkOS cannot be asked", async () => {
    const down = (async () => {
      throw new Error("getaddrinfo ENOTFOUND")
    }) as typeof fetch
    const refusal = await stagingRefusal(
      { clientId: STAGING_CLIENT_ID, apiKey: "key" },
      down
    )
    expect(refusal).toContain("ENOTFOUND")
  })

  it("refuses an empty key", async () => {
    const refusal = await stagingRefusal(
      { clientId: STAGING_CLIENT_ID, apiKey: "" },
      answering(400, { error: "invalid_grant" })
    )
    expect(refusal).toContain("empty")
  })

  it("passes staging's key, which only fails the dummy code", async () => {
    const refusal = await stagingRefusal(
      { clientId: STAGING_CLIENT_ID, apiKey: "key" },
      answering(400, { error: "invalid_grant" })
    )
    expect(refusal).toBeNull()
  })
})

const owner = devOwner("someone@example.org")

describe("the owner", () => {
  it("is one per developer, named from their git address", () => {
    expect(owner.email).toMatch(/^owner\+dev-[0-9a-f]{8}@example\.net$/)
    expect(devOwner(" Someone@Example.org ")).toEqual(owner)
    const other = devOwner("someone-else@example.org")
    expect(other.email).not.toBe(owner.email)
    expect(other.orgName).not.toBe(owner.orgName)
    expect(owner.orgName).toContain("(fictional)")
    expect(owner.orgName).toContain(owner.email.slice(10, 18))
  })

  it("needs a git address to be named from", () => {
    expect(() => devOwner("")).toThrow("git config user.email")
  })

  it("is one user after two runs, with a new password each time", async () => {
    const workos = fakeWorkos()
    const first = await ensureOwner(workos, owner, "one")
    const second = await ensureOwner(workos, owner, "two")
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.user.id).toBe(first.user.id)
    expect(workos.users.size).toBe(1)
    expect(workos.passwords).toEqual(["one", "two"])
  })

  it("is created verified, since the address receives no mail", async () => {
    const workos = fakeWorkos()
    await ensureOwner(workos, owner, "one")
    expect(workos.createdWith).toEqual([
      {
        email: owner.email,
        password: "one",
        firstName: "Dev",
        lastName: "Owner",
        emailVerified: true,
      },
    ])
  })

  it("is removed with its own org and not with another", async () => {
    const workos = fakeWorkos()
    const { user } = await ensureOwner(workos, owner, "one")
    workos.memberships.push(
      {
        userId: user.id,
        organizationId: "org_dev",
        organizationName: owner.orgName,
      },
      {
        userId: user.id,
        organizationId: "org_real",
        organizationName: "A real business",
      }
    )
    expect(await removeOwner(workos, owner)).toEqual({
      userId: user.id,
      orgIds: ["org_dev"],
    })
    expect(workos.deletedOrgs).toEqual(["org_dev"])
    expect(workos.users.size).toBe(0)
  })

  it("is a no-op to remove twice, and comes back after", async () => {
    const workos = fakeWorkos()
    await ensureOwner(workos, owner, "one")
    await removeOwner(workos, owner)
    expect(await removeOwner(workos, owner)).toEqual({
      userId: null,
      orgIds: [],
    })
    expect((await ensureOwner(workos, owner, "two")).created).toBe(true)
  })

  it("is cleared locally before WorkOS is touched", async () => {
    const workos = fakeWorkos()
    await ensureOwner(workos, owner, "one")
    const order: string[] = []
    const gone = await deleteOwner(workos, owner, async () => {
      order.push("local")
      expect(workos.users.size).toBe(1)
      return { orgs: 1, users: 1 }
    })
    expect(order).toEqual(["local"])
    expect(gone.local).toEqual({ orgs: 1, users: 1 })
    expect(workos.users.size).toBe(0)
  })

  it("stays in WorkOS when the local clear fails", async () => {
    const workos = fakeWorkos()
    await ensureOwner(workos, owner, "one")
    await expect(
      deleteOwner(workos, owner, async () => {
        throw new Error("violates foreign key constraint")
      })
    ).rejects.toThrow("foreign key")
    expect(workos.users.size).toBe(1)
  })
})

describe("the owner's org", () => {
  const named = (organizationName: string) => ({
    organizationId: `org_${organizationName}`,
    organizationName,
  })

  it("is fine with none yet, or with its own", () => {
    expect(membershipRefusal([], owner)).toBeNull()
    expect(membershipRefusal([named(owner.orgName)], owner)).toBeNull()
  })

  it("refuses two, which WorkOS answers with a choice to make", () => {
    const refusal = membershipRefusal(
      [named(owner.orgName), named("Another business")],
      owner
    )
    expect(refusal).toContain("2 organizations")
    expect(refusal).toContain("Another business")
  })

  it("refuses one it did not make, rather than adopting it", () => {
    expect(membershipRefusal([named("A real business")], owner)).toContain(
      "A real business"
    )
  })
})

describe("the previous session", () => {
  it("is revoked when it belongs to this owner", async () => {
    const workos = fakeWorkos()
    const previous = { userId: "user_1", sessionId: "session_old" }
    expect(await retireSession(workos, previous, "user_1")).toBe("revoked")
    expect(workos.revoked).toEqual(["session_old"])
  })

  it("is left alone when it is someone else's, or there is none", async () => {
    const workos = fakeWorkos()
    const theirs = { userId: "user_2", sessionId: "session_theirs" }
    expect(await retireSession(workos, theirs, "user_1")).toBe("none")
    expect(await retireSession(workos, null, "user_1")).toBe("none")
    expect(await retireSession(workos, { userId: "user_1" }, "user_1")).toBe(
      "none"
    )
    expect(workos.revoked).toEqual([])
  })

  it("counts as gone when WorkOS already ended it", async () => {
    const workos = fakeWorkos()
    const previous = { userId: "user_1", sessionId: "session_old" }
    await retireSession(workos, previous, "user_1")
    expect(await retireSession(workos, previous, "user_1")).toBe("gone")
  })
})

describe("the local servers", () => {
  const root = "/work/reme"
  const page = (html: string) =>
    (async () => new Response(html, { status: 200 })) as typeof fetch
  const json = (body: unknown, status = 200) =>
    (async () => Response.json(body, { status })) as typeof fetch
  const refused = (async () => {
    throw new TypeError("fetch failed")
  }) as typeof fetch
  const healthy = {
    status: "ok",
    role: "reme_app",
    bypasses_rls: false,
    org_context: "x",
    rows_for_absent_org: 0,
  }

  it("knows this checkout's web by the path Vite serves from", async () => {
    const ours = `<title>Reme</title><link href="/@fs${root}/packages/ui/x.css">`
    expect(await appOn("web", "http://w", root, page(ours))).toBe("ours")
    const other = `<title>Reme</title><link href="/@fs/elsewhere/packages/ui/x.css">`
    expect(await appOn("web", "http://w", root, page(other))).toBe("foreign")
    expect(await appOn("web", "http://w", root, refused)).toBe("absent")
  })

  it("knows the api by its health report, and only a passing one", async () => {
    expect(await appOn("api", "http://a", root, json(healthy))).toBe("ours")
    expect(
      await appOn(
        "api",
        "http://a",
        root,
        json({ ...healthy, status: "degraded" }, 503)
      )
    ).toBe("unhealthy")
    expect(await appOn("api", "http://a", root, json({ ok: true }))).toBe(
      "foreign"
    )
    expect(await appOn("api", "http://a", root, page("<html></html>"))).toBe(
      "foreign"
    )
    expect(await appOn("api", "http://a", root, refused)).toBe("absent")
  })

  it("starts only what is not answering", () => {
    expect(startPlan({ web: "absent", api: "absent" })).toEqual({
      start: ["web", "api"],
    })
    expect(startPlan({ web: "ours", api: "absent" })).toEqual({
      start: ["api"],
    })
    expect(startPlan({ web: "absent", api: "ours" })).toEqual({
      start: ["web"],
    })
    expect(startPlan({ web: "ours", api: "ours" })).toEqual({ start: [] })
  })

  it("refuses a port held by something that is not ours", () => {
    expect(startPlan({ web: "foreign", api: "absent" }).refusal).toContain(
      "3000"
    )
    expect(startPlan({ web: "ours", api: "unhealthy" }).refusal).toContain(
      "3001"
    )
  })
})

describe("the stored session", () => {
  const sessions = (status: string, sid = "session_user_dev") => ({
    userManagement: {
      // The SDK's own unseal, so a password mismatch is the real one.
      getSessionFromCookie: async (options: {
        sessionData: string
        cookiePassword: string
      }) => {
        const { WorkOS } = await import("@workos-inc/node")
        return new WorkOS("unused", {
          clientId: "unused",
        }).userManagement.getSessionFromCookie(options)
      },
      // Two pages, the live one on the second: a read of `.data` alone would
      // see only the first.
      listSessions: async () => ({
        data: [{ id: "session_other", status: "active" }],
        autoPagination: async () => [
          { id: "session_other", status: "active" },
          { id: sid, status },
        ],
      }),
    },
  })

  it("is valid while its WorkOS session is active", async () => {
    const sealed = await sessionCookie({ sub: "user_dev" })
    expect(
      await sessionStatus(sessions("active"), sealed, COOKIE_PASSWORD)
    ).toBe("valid")
  })

  it("is unsealable under another cookie password", async () => {
    const sealed = await sessionCookie({ sub: "user_dev" })
    expect(
      await sessionStatus(sessions("active"), sealed, OTHER_PASSWORD)
    ).toBe("unsealable")
  })

  it("has ended once WorkOS revokes it", async () => {
    const sealed = await sessionCookie({ sub: "user_dev" })
    expect(
      await sessionStatus(sessions("revoked"), sealed, COOKIE_PASSWORD)
    ).toBe("ended")
  })

  it("has ended when its user is gone", async () => {
    const sealed = await sessionCookie({ sub: "user_dev" })
    const gone = {
      userManagement: {
        ...sessions("active").userManagement,
        listSessions: async () => {
          throw Object.assign(new Error("not found"), { status: 404 })
        },
      },
    }
    expect(await sessionStatus(gone, sealed, COOKIE_PASSWORD)).toBe("ended")
  })
})

/**
 * `--delete` then a run again, on the database. WorkOS gives the owner a new
 * id the second time, and the old mirror row still holds the address.
 * Its own address and org name, so the real development owner in a shared
 * database is never touched.
 */
describe.skipIf(!process.env.DATABASE_URL)("the local mirror", () => {
  const kit = tenancy(process.env.DATABASE_URL as string, { max: 2 })
  afterAll(() => kit.close())

  const email = "owner+dev-probe@api-writer.invalid"
  const orgName = "Dev Owner Probe (fixture)"

  /** A WorkOS in which this person has just been created and joined nothing. */
  const signup = (workosUserId: string) => {
    const joined: { id: string; organizationId: string }[] = []
    const directory: Directory = {
      createOrganization: async () => ({ id: `org_${workosUserId}` }),
      listOrganizationMemberships: async () => ({ data: joined }),
      createOrganizationMembership: async ({ organizationId }) => {
        const membership = { id: `om_${workosUserId}`, organizationId }
        joined.push(membership)
        return membership
      },
    }
    return createOrg(kit, directory, {
      name: orgName,
      idempotencyKey: `org:${workosUserId}`,
      workosUserId,
      email,
      displayName: "Dev Probe",
    })
  }

  it("lets the same address sign up again once it is cleared", async () => {
    await clearOwner(email, orgName)
    const first = `user_dev_probe_${crypto.randomUUID()}`
    const second = `user_dev_probe_${crypto.randomUUID()}`
    await signup(first)

    // The reason it exists: the old row holds the address.
    await expect(signup(second)).rejects.toBeInstanceOf(EmailTaken)

    expect(await clearOwner(email, orgName)).toEqual({ orgs: 1, users: 1 })
    expect(
      await resolveOrg(kit, {
        workosUserId: first,
        workosOrganizationId: `org_${first}`,
      })
    ).toBeNull()

    expect((await signup(second)).name).toBe(orgName)
    expect(await clearOwner(email, orgName)).toEqual({ orgs: 1, users: 1 })
    expect(await clearOwner(email, orgName)).toEqual({ orgs: 0, users: 0 })
  }, 60_000)
})
