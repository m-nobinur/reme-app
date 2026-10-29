import { beforeEach, expect, it, vi } from "vitest"

/**
 * The naming page asks on load whether the session still refreshes, so a
 * dead one sends the owner to sign in before they type a name.
 */

vi.mock("cloudflare:workers", () => ({ env: {} }))
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const builder = {
      validator: () => builder,
      handler: (run: () => unknown) => () => Promise.resolve().then(run),
    }
    return builder
  },
}))

const kit = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
  refreshSession: vi.fn(),
  saveSession: vi.fn(),
  clearSession: vi.fn(),
}))
vi.mock("@workos/authkit-tanstack-react-start", () => ({
  getAuthKitContextOrNull: () => ({ auth: () => kit.auth }),
  getAuthkit: async () => kit,
}))
vi.mock("@/lib/api/transport", () => ({ forwardedSession: vi.fn() }))
vi.mock("./workos", () => ({ workos: vi.fn(), sessionOptions: () => ({}) }))

const { sessionRefreshes } = await import("./actions")

beforeEach(() => {
  vi.clearAllMocks()
  kit.auth = {
    user: { id: "user_owner" },
    accessToken: "access",
    refreshToken: "refresh",
    organizationId: "org_gone",
  }
})

it("keeps a session that refreshes, with the new seal saved", async () => {
  kit.refreshSession.mockResolvedValue({ encryptedSession: "fresh" })
  expect(await sessionRefreshes()).toBe(true)
  expect(kit.refreshSession.mock.calls[0]?.[1]).toBe("org_gone")
  expect(kit.saveSession).toHaveBeenCalledWith(undefined, "fresh")
  expect(kit.clearSession).not.toHaveBeenCalled()
})

it("ends a session WorkOS refuses to refresh", async () => {
  kit.refreshSession.mockRejectedValue(
    new Error("refresh failed", { cause: { error: "invalid_grant" } })
  )
  expect(await sessionRefreshes()).toBe(false)
  expect(kit.clearSession).toHaveBeenCalledOnce()
})

it("keeps the session when WorkOS did not answer", async () => {
  kit.refreshSession.mockRejectedValue(new TypeError("fetch failed"))
  expect(await sessionRefreshes()).toBe(true)
  expect(kit.clearSession).not.toHaveBeenCalled()
})

it("has nothing to refresh with no user", async () => {
  kit.auth = {}
  expect(await sessionRefreshes()).toBe(false)
  expect(kit.refreshSession).not.toHaveBeenCalled()
})
