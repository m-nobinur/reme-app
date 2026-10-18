import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Each MFA call only runs on the step WorkOS asked for. Someone holding a
 * password but not the authenticator lands on the challenge step; if
 * enrolment worked there, they could add their own factor and answer the
 * challenge with it.
 *
 * `createServerFn` is replaced by a builder that hands back the handler
 * itself, so each export here is the function the server runs, called
 * directly.
 */

const readPending = vi.fn()
const createUserAuthFactor = vi.fn()
const listUserAuthFactors = vi.fn()
const challengeFactor = vi.fn()
const authenticate = vi.fn()

vi.mock("cloudflare:workers", () => ({ env: {} }))

vi.mock("@tanstack/react-start", () => {
  const builder = {
    validator: () => builder,
    handler: (fn: unknown) => fn,
  }
  return { createServerFn: () => builder }
})

vi.mock("./pending", () => ({
  readPending: () => readPending(),
  updatePending: vi.fn(),
  clearPending: vi.fn(),
}))

vi.mock("./workos", () => ({
  workos: () => ({
    multiFactorAuth: {
      createUserAuthFactor,
      listUserAuthFactors,
      challengeFactor,
    },
  }),
  sessionOptions: () => ({}),
}))

vi.mock("./session", () => ({
  authenticate: (...args: unknown[]) => authenticate(...args),
  writeSession: vi.fn(),
}))

const actions = (await import("./actions")) as unknown as Record<
  string,
  (args?: { data: Record<string, string> }) => Promise<unknown>
>

const cookie = (step: string) => ({
  token: "pending",
  userId: "user_probe",
  email: "probe@example.net",
  challengeId: "auth_challenge_probe",
  step,
})

const expired = expect.objectContaining({ code: "no_pending_auth" })

beforeEach(() => {
  vi.clearAllMocks()
  createUserAuthFactor.mockResolvedValue({
    authenticationChallenge: { id: "auth_challenge_new" },
    authenticationFactor: { totp: { qrCode: "data:", secret: "s" } },
  })
  listUserAuthFactors.mockResolvedValue({
    data: [{ id: "auth_factor_probe", type: "totp" }],
  })
  challengeFactor.mockResolvedValue({ id: "auth_challenge_new" })
})

describe("enrolling a factor", () => {
  it("is refused on the challenge step", async () => {
    readPending.mockResolvedValue(cookie("mfa_challenge"))
    expect(await actions.startMfaEnrolment()).toEqual({ failure: expired })
    expect(createUserAuthFactor).not.toHaveBeenCalled()
  })

  it("is refused on a flow cookie that names no step", async () => {
    readPending.mockResolvedValue({ ...cookie(""), step: undefined })
    expect(await actions.startMfaEnrolment()).toEqual({ failure: expired })
    expect(createUserAuthFactor).not.toHaveBeenCalled()
  })

  it("runs on the enrolment step", async () => {
    readPending.mockResolvedValue(cookie("mfa_enrollment"))
    expect(await actions.startMfaEnrolment()).toEqual({
      qrCode: "data:",
      secret: "s",
    })
  })
})

describe("challenging a factor", () => {
  it("is refused on the enrolment step", async () => {
    readPending.mockResolvedValue(cookie("mfa_enrollment"))
    expect(await actions.startMfaChallenge()).toEqual({ failure: expired })
    expect(challengeFactor).not.toHaveBeenCalled()
  })

  it("runs on the challenge step", async () => {
    readPending.mockResolvedValue(cookie("mfa_challenge"))
    expect(await actions.startMfaChallenge()).toEqual({ challenged: true })
  })
})
