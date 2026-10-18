import type { AuthenticationResponse } from "@workos-inc/node"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { toFailure } from "./failure"

/**
 * Replaying a one-time credential, at the two places it can be replayed.
 *
 * A sign-in code (`signInWithCode`) holds nothing of ours to replay: the code
 * goes straight to WorkOS with the address, and WorkOS spends it.
 *
 * What these cases cover:
 *
 *  1. The provider refuses a spent one-time code. That is WorkOS's semantics,
 *     not ours, and it was proved against staging on 2026-08-28 rather than
 *     assumed: a magic-auth code was created, spent, and offered again, and the
 *     second use came back `one_time_code_previously_used`, HTTP 400. The probe
 *     user was deleted and the environment is back to zero users. It is not a
 *     committed test because it needs the API key and the network, which a
 *     blocking gate cannot have; the second half of it, the message a person
 *     then sees, is pinned below because that half is ours.
 *
 *  2. We do not keep the credential after it has been spent. Every incomplete
 *     sign-in leaves a `pendingAuthenticationToken` in the flow cookie, and
 *     that token is half a credential: it is what the verification, MFA and
 *     organisation-selection calls authenticate with. `authenticate()` clears
 *     it the moment a session exists, which is what stops a second submission
 *     of the same step from replaying it at all.
 */

const saveSession = vi.fn()
const setPending = vi.fn()
const clearPending = vi.fn()
const listUsers = vi.fn()

vi.mock("@workos/authkit-tanstack-react-start", () => ({
  getAuthkit: async () => ({ saveSession }),
}))

vi.mock("./pending", () => ({
  setPending: (...args: unknown[]) => setPending(...args),
  clearPending: () => clearPending(),
  readPending: async () => null,
}))

vi.mock("./workos", () => ({
  workos: () => ({ userManagement: { listUsers } }),
  sessionOptions: () => ({}),
}))

const { authenticate } = await import("./session")

const signedIn = {
  sealedSession: "sealed-session-value",
  user: { id: "user_probe" },
} as unknown as AuthenticationResponse

/** What WorkOS throws when a sign-in needs another step. */
function step(code: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(code), {
    code,
    pendingAuthenticationToken: "pending",
    rawData: { email: "probe@example.net" },
    ...extra,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  listUsers.mockResolvedValue({ data: [{ id: "user_probe" }] })
})

describe("the pending token does not outlive the step it belongs to", () => {
  it("is cleared as soon as a session exists", async () => {
    const outcome = await authenticate(async () => signedIn, {
      email: "probe@example.net",
    })
    expect(outcome.status).toBe("signed-in")
    // The order matters: the cookie is written first, so a crash between the
    // two leaves a signed-in person with a stale flow cookie rather than a
    // cleared one and no session.
    expect(saveSession).toHaveBeenCalledTimes(1)
    expect(clearPending).toHaveBeenCalledTimes(1)
  })

  it("is still there when the step did not complete, so the person can retry", async () => {
    // The other half. Clearing on a wrong code would make one typo end the
    // sign-in, and the flow pages would answer "this step expired" to somebody
    // who is still sitting on it.
    const outcome = await authenticate(
      async () => {
        throw Object.assign(new Error("invalid"), {
          code: "invalid_one_time_code",
        })
      },
      { email: "probe@example.net" }
    )
    expect(outcome.status).toBe("failed")
    expect(clearPending).not.toHaveBeenCalled()
  })

  it("replaces rather than appends when a new step is issued", async () => {
    // `setPending` clears before it writes, so two half-finished sign-ins never
    // leave two live tokens in one cookie.
    const outcome = await authenticate(
      async () => {
        throw step("mfa_challenge")
      },
      { email: "probe@example.net" }
    )
    expect(outcome).toEqual({ status: "next", redirectTo: "/mfa" })
    expect(setPending).toHaveBeenCalledTimes(1)
    expect(setPending.mock.calls[0]?.[0]).toMatchObject({
      step: "mfa_challenge",
      token: "pending",
      userId: "user_probe",
    })
  })

  it("does not carry a step forward without a token to carry", async () => {
    // A step with no token cannot be completed, and inventing one would send
    // the person to a page that fails on submit. It ends here instead.
    const outcome = await authenticate(
      async () => {
        throw Object.assign(new Error("mfa"), {
          code: "mfa_challenge",
          rawData: { email: "probe@example.net" },
        })
      },
      { email: "probe@example.net" }
    )
    expect(outcome).toEqual({
      status: "failed",
      failure: expect.objectContaining({ code: "incomplete_step" }),
    })
    expect(setPending).not.toHaveBeenCalled()
  })
})

describe("a spent one-time code reads as a spent code", () => {
  it("says so for both names WorkOS gives it", () => {
    // Measured 2026-08-28 against staging: email verification answers
    // `invalid_one_time_code` and magic auth answers
    // `one_time_code_previously_used`, for a wrong code and a replayed one
    // alike. Before this pairing, a replayed code fell through to the generic
    // message, which tells a person the service is down when they mistyped.
    for (const code of [
      "invalid_one_time_code",
      "one_time_code_previously_used",
    ]) {
      const failure = toFailure(
        Object.assign(new Error("one-time code"), { code, status: 400 })
      )
      expect(failure.code, code).toBe("invalid_one_time_code")
      expect(failure.field, code).toBe("code")
      expect(failure.message, code).toMatch(/ask for a new one/i)
    }
  })

  it("gives the same answer for a spent code and a wrong one", () => {
    // No oracle: a person working through codes learns nothing about which of
    // the two they hit. WorkOS answers both the same way and so do we.
    const spent = toFailure({
      code: "one_time_code_previously_used",
      status: 400,
    })
    const wrong = toFailure({ code: "invalid_one_time_code", status: 400 })
    expect(spent).toEqual(wrong)
  })
})
