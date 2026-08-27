import type { NoUserInfo, UserInfo } from "@workos/authkit-tanstack-react-start"
import { describe, expect, it } from "vitest"
import { record } from "./auth/input"
import { ownerFrom } from "./tenant"

/** A session as `getAuth()` returns it, with the claims WorkOS signed. */
function session(overrides: Partial<UserInfo> = {}): UserInfo {
  return {
    user: {
      object: "user",
      id: "user_01",
      email: "owner@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      emailVerified: true,
      profilePictureUrl: null,
      lastSignInAt: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      externalId: null,
      metadata: {},
    },
    sessionId: "session_01",
    organizationId: "org_real",
    role: "owner",
    accessToken: "sentinel",
    ...overrides,
  } as UserInfo
}

describe("resolving the tenant from the session", () => {
  it("has no owner when the request carries no session", () => {
    const none: NoUserInfo = { user: null }
    expect(ownerFrom(none)).toBeNull()
  })

  it("takes the organisation and the role from the session", () => {
    const owner = ownerFrom(session())
    expect(owner?.orgId).toBe("org_real")
    expect(owner?.role).toBe("owner")
    expect(owner?.userId).toBe("user_01")
    expect(owner?.name).toBe("Ada Lovelace")
  })

  it("reports no organisation rather than inventing one", () => {
    // What every session on staging looks like today: a verified user with no
    // organisation. The app has to say so, not guess.
    const owner = ownerFrom(
      session({ organizationId: undefined, role: undefined })
    )
    expect(owner?.orgId).toBeNull()
    expect(owner?.role).toBeNull()
  })

  it("keeps the access token out of loader data", () => {
    // This value is serialised into the page. The token is a bearer credential.
    // The fixture is short on purpose: the commit hook reads a longer string
    // next to the word `token` as a leaked credential, and it is right to.
    expect(JSON.stringify(ownerFrom(session()))).not.toContain("sentinel")
  })

  it("cannot be talked into another organisation by a request body", () => {
    // The two halves of the rule, together: a payload naming an organisation
    // is refused at the boundary, and the organisation the request runs under
    // is read from the session either way.
    expect(() => record({ org_id: "org_evil", page: 2 })).toThrow(
      /may not name an organisation/
    )
    expect(ownerFrom(session())?.orgId).toBe("org_real")
  })
})
