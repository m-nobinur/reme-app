import { beforeEach, expect, it, vi } from "vitest"

/**
 * Item 32: a signup whose organisation write failed is not stranded. The
 * business name was recorded at signup; the /app frame calls `retryOrgWrite`
 * on the next visit, which writes the organisation under the same key and
 * puts the refreshed session in the cookie.
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

const auth = vi.hoisted(() => ({
  current: {} as { user?: { id: string }; organizationId?: string },
}))
vi.mock("@workos/authkit-tanstack-react-start", () => ({
  getAuthKitContextOrNull: () => ({ auth: () => auth.current }),
}))
vi.mock("@/lib/api/transport", () => ({
  forwardedSession: async () => SEALED,
}))

const intent = vi.hoisted(() => ({
  read: vi.fn(),
  clear: vi.fn(),
}))
vi.mock("./org-intent", () => ({
  readOrgIntent: () => intent.read(),
  clearOrgIntent: () => intent.clear(),
}))
const createOrgForSession = vi.fn()
vi.mock("./org", () => ({
  createOrgForSession: (...args: unknown[]) => createOrgForSession(...args),
}))
const writeSession = vi.fn()
vi.mock("./session", () => ({
  authenticate: vi.fn(),
  writeSession: (...args: unknown[]) => writeSession(...args),
}))
vi.mock("./workos", () => ({ workos: vi.fn(), sessionOptions: () => ({}) }))

const SEALED = "sealed-without-the-org"
const REFRESHED = "sealed-with-the-org"

const { retryOrgWrite } = await import("./actions")

beforeEach(() => {
  vi.clearAllMocks()
  auth.current = { user: { id: "user_probe" } }
  intent.read.mockResolvedValue({
    userId: "user_probe",
    orgName: "Sparkle Clean",
  })
  createOrgForSession.mockResolvedValue(REFRESHED)
})

it("writes the organisation the signup asked for, and the session that carries it", async () => {
  expect(await retryOrgWrite()).toBe(true)
  expect(createOrgForSession).toHaveBeenCalledWith({
    sealedSession: SEALED,
    workosUserId: "user_probe",
    name: "Sparkle Clean",
  })
  expect(writeSession).toHaveBeenCalledWith(REFRESHED)
  expect(intent.clear).toHaveBeenCalledOnce()
})

it("keeps the name for the next visit when the write fails again", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  createOrgForSession.mockRejectedValue(new Error("apps/api answered 504"))
  expect(await retryOrgWrite()).toBe(false)
  // Or when it lands and the session still has no organisation in it.
  createOrgForSession.mockResolvedValue(SEALED)
  expect(await retryOrgWrite()).toBe(false)
  expect(writeSession).not.toHaveBeenCalled()
  expect(intent.clear).not.toHaveBeenCalled()
})

it("writes nothing for another account, or for a session that has an organisation", async () => {
  auth.current = { user: { id: "user_someone_else" } }
  expect(await retryOrgWrite()).toBe(false)
  auth.current = { user: { id: "user_probe" }, organizationId: "org_01" }
  expect(await retryOrgWrite()).toBe(false)
  intent.read.mockResolvedValue(null)
  auth.current = { user: { id: "user_probe" } }
  expect(await retryOrgWrite()).toBe(false)
  expect(createOrgForSession).not.toHaveBeenCalled()
})
