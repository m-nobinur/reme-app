import { resolveOrg, tenancy } from "@workspace/db"
import { clearOwner } from "@workspace/db/fixtures/seed"
import { afterAll, describe, expect, it } from "vitest"
import {
  DEV_OWNER,
  ensureOwner,
  removeOwner,
  STAGING_CLIENT_ID,
  sessionStatus,
  stagingRefusal,
  // @ts-expect-error plain ESM, deliberately runnable without a build
} from "../scripts/dev-owner.mjs"
import { createOrg, type Directory } from "../src/org.ts"
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
  let next = 0
  return {
    users,
    memberships,
    deletedOrgs,
    passwords,
    userManagement: {
      listUsers: async ({ email }: { email: string }) => ({
        data: [...users.values()].filter((u) => u.email === email),
      }),
      createUser: async (input: { email: string; password: string }) => {
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

describe("the owner", () => {
  it("is one user after two runs, with a new password each time", async () => {
    const workos = fakeWorkos()
    const first = await ensureOwner(workos, "one")
    const second = await ensureOwner(workos, "two")
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(second.user.id).toBe(first.user.id)
    expect(workos.users.size).toBe(1)
    expect(workos.passwords).toEqual(["one", "two"])
  })

  it("is removed with its own org and not with another", async () => {
    const workos = fakeWorkos()
    const { user } = await ensureOwner(workos, "one")
    workos.memberships.push(
      {
        userId: user.id,
        organizationId: "org_dev",
        organizationName: DEV_OWNER.orgName,
      },
      {
        userId: user.id,
        organizationId: "org_real",
        organizationName: "A real business",
      }
    )
    expect(await removeOwner(workos)).toEqual({
      userId: user.id,
      orgIds: ["org_dev"],
    })
    expect(workos.deletedOrgs).toEqual(["org_dev"])
    expect(workos.users.size).toBe(0)
  })

  it("is a no-op to remove twice, and comes back after", async () => {
    const workos = fakeWorkos()
    await ensureOwner(workos, "one")
    await removeOwner(workos)
    expect(await removeOwner(workos)).toEqual({ userId: null, orgIds: [] })
    expect((await ensureOwner(workos, "two")).created).toBe(true)
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
      listSessions: async () => ({ data: [{ id: sid, status }] }),
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
    await expect(signup(second)).rejects.toThrow(
      "neither inserted nor readable"
    )

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
