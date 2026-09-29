import type { AuthenticationResponse } from "@workos-inc/node"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * When the organisation gets created, and what gets written to the cookie.
 *
 * Signup rarely reaches a session on the first call: the environment requires a
 * verified email, so the business name is typed on /sign-up and the session
 * that can act on it arrives on /verify-email. These cases pin the two ends of
 * that: the name is carried in the flow cookie, and the write happens once, at
 * the moment the session lands.
 *
 * The last case is the one that has to hold. Creating the org is not what
 * signing up is for, and by the time it runs the WorkOS user already exists, so
 * a failure here must not cost the person the account they just made.
 */

const saveSession = vi.fn()
const setPending = vi.fn()
const clearPending = vi.fn()
const readPending = vi.fn()
const createOrgForSession = vi.fn()
const recordOrgIntent = vi.fn()

vi.mock("@workos/authkit-tanstack-react-start", () => ({
  getAuthkit: async () => ({ saveSession }),
}))

vi.mock("./pending", () => ({
  setPending: (...args: unknown[]) => setPending(...args),
  clearPending: () => clearPending(),
  readPending: () => readPending(),
}))

vi.mock("./workos", () => ({
  workos: () => ({ userManagement: { listUsers: async () => ({ data: [] }) } }),
  sessionOptions: () => ({}),
}))

vi.mock("./org", () => ({
  createOrgForSession: (...args: unknown[]) => createOrgForSession(...args),
}))

vi.mock("./org-intent", () => ({
  recordOrgIntent: (...args: unknown[]) => recordOrgIntent(...args),
}))

const { authenticate } = await import("./session")

const SEALED = "sealed-before-the-org"
const REFRESHED = "sealed-with-the-org"

function signedIn(organizationId?: string): AuthenticationResponse {
  return {
    sealedSession: SEALED,
    organizationId,
    user: { id: "user_probe" },
  } as unknown as AuthenticationResponse
}

beforeEach(() => {
  vi.clearAllMocks()
  readPending.mockResolvedValue(null)
  createOrgForSession.mockResolvedValue(REFRESHED)
  recordOrgIntent.mockResolvedValue(undefined)
})

describe("the organisation a signup asked for", () => {
  it("is created when the session lands, and the refreshed session is written", async () => {
    const outcome = await authenticate(async () => signedIn(), {
      email: "probe@example.net",
      orgName: "Sparkle Clean",
    })

    expect(outcome.status).toBe("signed-in")
    expect(createOrgForSession).toHaveBeenCalledWith({
      sealedSession: SEALED,
      workosUserId: "user_probe",
      name: "Sparkle Clean",
    })
    // The whole point of the refresh: without it the session carries no
    // org_id claim and apps/api answers GET /org with 403 org.unresolved.
    expect(saveSession).toHaveBeenCalledWith(undefined, REFRESHED)
    expect(recordOrgIntent).not.toHaveBeenCalled()
  })

  it("survives the hop to email verification in the flow cookie", async () => {
    // Signup answers `email_verification_required` on this environment, so the
    // name has to be in the pending record or it is gone by the time there is
    // a session to use it.
    const outcome = await authenticate(
      async () => {
        throw Object.assign(new Error("verify"), {
          code: "email_verification_required",
          pendingAuthenticationToken: "pending",
          rawData: { email: "probe@example.net", user: { id: "user_probe" } },
        })
      },
      { email: "probe@example.net", orgName: "Sparkle Clean" }
    )

    expect(outcome).toEqual({ status: "next", redirectTo: "/verify-email" })
    expect(setPending.mock.calls[0]?.[0]).toMatchObject({
      orgName: "Sparkle Clean",
    })
  })

  it("is picked up from the flow cookie by the step that finishes the sign-in", async () => {
    // /verify-email does not know a signup started this. It passes no name,
    // and the name comes back out of the cookie the step before it wrote.
    readPending.mockResolvedValue({
      token: "pending",
      userId: "user_probe",
      email: "probe@example.net",
      orgName: "Sparkle Clean",
    })

    await authenticate(async () => signedIn(), { email: "probe@example.net" })
    expect(createOrgForSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Sparkle Clean" })
    )
  })

  it("is not created again for a session that already has one", async () => {
    readPending.mockResolvedValue({
      token: "pending",
      userId: "user_probe",
      email: "probe@example.net",
      orgName: "Sparkle Clean",
    })

    await authenticate(async () => signedIn("org_01ALREADY"), {
      email: "probe@example.net",
    })
    expect(createOrgForSession).not.toHaveBeenCalled()
    expect(saveSession).toHaveBeenCalledWith(undefined, SEALED)
  })

  it("is never attempted by a plain sign-in", async () => {
    await authenticate(async () => signedIn(), { email: "probe@example.net" })
    expect(createOrgForSession).not.toHaveBeenCalled()
  })

  it("does not cost the person the account when it fails", async () => {
    // The WorkOS user exists by now. Refusing the sign-in would leave them with
    // an account they cannot reach and a signup form that answers "email
    // already in use", so this signs them in without an organisation.
    createOrgForSession.mockRejectedValue(new Error("apps/api refused"))

    const outcome = await authenticate(async () => signedIn(), {
      email: "probe@example.net",
      orgName: "Sparkle Clean",
    })
    expect(outcome.status).toBe("signed-in")
    expect(saveSession).toHaveBeenCalledWith(undefined, SEALED)
    // Kept for the /app frame to write on the next visit.
    expect(recordOrgIntent).toHaveBeenCalledWith({
      userId: "user_probe",
      orgName: "Sparkle Clean",
    })
  })

  it("is kept for the next visit when the org lands but the session lacks it", async () => {
    // The refresh into the new organisation can fail without throwing; the
    // session comes back unchanged, and the person still has no organisation.
    createOrgForSession.mockResolvedValue(SEALED)
    await authenticate(async () => signedIn(), {
      email: "probe@example.net",
      orgName: "Sparkle Clean",
    })
    expect(recordOrgIntent).toHaveBeenCalledOnce()
  })

  it("signs the person in even when the name cannot be kept", async () => {
    createOrgForSession.mockRejectedValue(new Error("apps/api refused"))
    recordOrgIntent.mockRejectedValue(new Error("no cookie"))
    const outcome = await authenticate(async () => signedIn(), {
      email: "probe@example.net",
      orgName: "Sparkle Clean",
    })
    expect(outcome.status).toBe("signed-in")
  })
})
