import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * That sign-up and both halves of a password reset and of a sign-in code ask
 * the limiter before they reach WorkOS. `throttle.test.ts` covers the
 * decision; this covers the handlers calling it, which is the part that
 * silently goes missing.
 *
 * `createServerFn` is replaced by a builder that hands back the handler itself,
 * so each export here is the function the server runs, called directly.
 */

const limit = vi.fn()
const createUser = vi.fn()
const createPasswordReset = vi.fn()
const resetPassword = vi.fn()
const createMagicAuth = vi.fn()
const authenticateWithMagicAuth = vi.fn()
const authenticate = vi.fn()
const sendVerificationEmail = vi.fn()
const authenticateWithEmailVerification = vi.fn()

vi.mock("cloudflare:workers", () => ({ env: { SIGN_IN_LIMIT: { limit } } }))

vi.mock("./pending", () => ({
  readPending: async () => ({
    token: "pending",
    userId: "user_probe",
    email: "Dana@Brightclean.invalid",
  }),
  updatePending: vi.fn(),
  clearPending: vi.fn(),
}))

vi.mock("@tanstack/react-start", () => {
  const builder = {
    validator: () => builder,
    handler: (fn: unknown) => fn,
  }
  return { createServerFn: () => builder }
})

vi.mock("./workos", () => ({
  workos: () => ({
    userManagement: {
      createUser,
      createPasswordReset,
      resetPassword,
      createMagicAuth,
      authenticateWithMagicAuth,
      sendVerificationEmail,
      authenticateWithEmailVerification,
    },
  }),
  sessionOptions: () => ({}),
}))

// The session writer is `session.ts`'s and is tested there. Here it only has
// to be the one a code sign-in hands its attempt to.
vi.mock("./session", () => ({
  authenticate: (...args: unknown[]) => authenticate(...args),
  writeSession: vi.fn(),
}))

const actions = (await import("./actions")) as unknown as Record<
  string,
  (args: { data: Record<string, string> }) => Promise<unknown>
>

const refused = expect.objectContaining({ code: "rate_limited" })

beforeEach(() => {
  vi.clearAllMocks()
  limit.mockResolvedValue({ success: false })
})

describe("a limited form does not reach WorkOS", () => {
  it("sign-up, counted on the address", async () => {
    const outcome = await actions.signUp({
      data: { email: " Dana@Brightclean.invalid", password: "x".repeat(12) },
    })
    expect(outcome).toEqual({ status: "failed", failure: refused })
    expect(limit).toHaveBeenCalledWith({
      key: "sign-up:dana@brightclean.invalid",
    })
    expect(createUser).not.toHaveBeenCalled()
  })

  it("asking for a reset email, counted on the address", async () => {
    const outcome = await actions.requestPasswordReset({
      data: { email: "dana@brightclean.invalid" },
    })
    expect(outcome).toEqual({ failure: refused })
    expect(limit).toHaveBeenCalledWith({
      key: "reset-request:dana@brightclean.invalid",
    })
    expect(createPasswordReset).not.toHaveBeenCalled()
  })

  it("asking for a sign-in code, counted on the address", async () => {
    const outcome = await actions.sendSignInCode({
      data: { email: "Dana@Brightclean.invalid" },
    })
    expect(outcome).toEqual({ failure: refused })
    expect(limit).toHaveBeenCalledWith({
      key: "sign-in-code:dana@brightclean.invalid",
    })
    expect(createMagicAuth).not.toHaveBeenCalled()
  })

  it("entering a sign-in code, in the password's bucket", async () => {
    const outcome = await actions.signInWithCode({
      data: { email: "dana@brightclean.invalid", code: "123456" },
    })
    expect(outcome).toEqual({ status: "failed", failure: refused })
    expect(limit).toHaveBeenCalledWith({
      key: "sign-in:dana@brightclean.invalid",
    })
    expect(authenticate).not.toHaveBeenCalled()
  })

  it("setting the new password, counted on the link", async () => {
    const outcome = await actions.resetPassword({
      data: { token: "rt_probe", password: "x".repeat(12) },
    })
    expect(outcome).toEqual({ failure: refused })
    expect(limit).toHaveBeenCalledWith({ key: "reset:rt_probe" })
    expect(resetPassword).not.toHaveBeenCalled()
  })

  it("resending the verification email, counted on the address", async () => {
    const outcome = await actions.resendVerification({ data: {} })
    expect(outcome).toEqual({ sent: false, failure: refused })
    expect(limit).toHaveBeenCalledWith({
      key: "verify-resend:dana@brightclean.invalid",
    })
    expect(sendVerificationEmail).not.toHaveBeenCalled()
  })

  it("entering the verification code, counted on the user", async () => {
    const outcome = await actions.verifyEmail({ data: { code: "123456" } })
    expect(outcome).toEqual({ status: "failed", failure: refused })
    expect(limit).toHaveBeenCalledWith({ key: "verify:user_probe" })
    expect(authenticate).not.toHaveBeenCalled()
  })
})

describe("an allowed form goes through", () => {
  it("asks for the reset email once the limiter lets it", async () => {
    limit.mockResolvedValue({ success: true })
    createPasswordReset.mockResolvedValue({})
    const outcome = await actions.requestPasswordReset({
      data: { email: "dana@brightclean.invalid" },
    })
    expect(outcome).toEqual({ sent: true })
    expect(createPasswordReset).toHaveBeenCalledOnce()
  })
})

describe("the sign-in code, once the limiter lets it", () => {
  beforeEach(() => {
    limit.mockResolvedValue({ success: true })
  })

  it("answers the same whether or not the address has an account", async () => {
    createMagicAuth.mockResolvedValueOnce({ id: "magic_auth_probe" })
    const known = await actions.sendSignInCode({
      data: { email: "dana@brightclean.invalid" },
    })
    createMagicAuth.mockRejectedValueOnce(
      Object.assign(new Error("not found"), {
        code: "entity_not_found",
        status: 404,
      })
    )
    const unknown = await actions.sendSignInCode({
      data: { email: "nobody@brightclean.invalid" },
    })
    expect(known).toEqual({ sent: true })
    expect(unknown).toEqual(known)
  })

  it("reports a timeout rather than claiming the code was sent", async () => {
    createMagicAuth.mockRejectedValueOnce({ status: 408 })
    const outcome = await actions.sendSignInCode({
      data: { email: "dana@brightclean.invalid" },
    })
    expect(outcome).toEqual({
      failure: expect.objectContaining({ code: "timeout" }),
    })
  })

  it("signs in through the same session path as a password", async () => {
    authenticate.mockResolvedValueOnce({
      status: "signed-in",
      redirectTo: "/app/approvals",
    })
    const outcome = await actions.signInWithCode({
      data: {
        email: "dana@brightclean.invalid",
        code: "123456",
        returnTo: "/app/approvals",
      },
    })
    expect(outcome).toEqual({
      status: "signed-in",
      redirectTo: "/app/approvals",
    })
    expect(authenticate).toHaveBeenCalledWith(expect.any(Function), {
      email: "dana@brightclean.invalid",
      returnTo: "/app/approvals",
    })
    // The attempt it hands over is Magic Auth with the address and the code.
    const attempt = authenticate.mock.calls[0]?.[0] as () => Promise<unknown>
    await attempt()
    expect(authenticateWithMagicAuth).toHaveBeenCalledWith({
      email: "dana@brightclean.invalid",
      code: "123456",
    })
  })
})
