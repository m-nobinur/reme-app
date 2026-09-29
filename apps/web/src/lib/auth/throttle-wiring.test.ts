import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * That sign-up and both halves of a password reset ask the limiter before
 * they reach WorkOS. `throttle.test.ts` covers the decision; this covers the
 * handlers calling it, which is the part that silently goes missing.
 *
 * `createServerFn` is replaced by a builder that hands back the handler itself,
 * so each export here is the function the server runs, called directly.
 */

const limit = vi.fn()
const createUser = vi.fn()
const createPasswordReset = vi.fn()
const resetPassword = vi.fn()

vi.mock("cloudflare:workers", () => ({ env: { SIGN_IN_LIMIT: { limit } } }))

vi.mock("@tanstack/react-start", () => {
  const builder = {
    validator: () => builder,
    handler: (fn: unknown) => fn,
  }
  return { createServerFn: () => builder }
})

vi.mock("./workos", () => ({
  workos: () => ({
    userManagement: { createUser, createPasswordReset, resetPassword },
  }),
  sessionOptions: () => ({}),
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

  it("setting the new password, counted on the link", async () => {
    const outcome = await actions.resetPassword({
      data: { token: "rt_probe", password: "x".repeat(12) },
    })
    expect(outcome).toEqual({ failure: refused })
    expect(limit).toHaveBeenCalledWith({ key: "reset:rt_probe" })
    expect(resetPassword).not.toHaveBeenCalled()
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
