import { beforeEach, expect, it, vi } from "vitest"

const signOut = vi.fn(async (_options: unknown) => undefined)
const getAuth = vi.fn()

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    handler: (run: () => unknown) => () => run(),
  }),
}))
vi.mock("@tanstack/react-start/server", () => ({
  getRequestUrl: () =>
    new URL("https://pr-141-reme-web.beapp.workers.dev/sign-out"),
}))
vi.mock("@workos/authkit-tanstack-react-start", () => ({ signOut, getAuth }))

beforeEach(() => {
  signOut.mockClear()
})

it("returns to the home page of the deployment the owner is on", async () => {
  getAuth.mockResolvedValueOnce({ user: { id: "user_probe" } })
  const { signOutHere } = await import("./sign-out")
  await signOutHere()
  expect(signOut).toHaveBeenCalledWith({
    data: { returnTo: "https://pr-141-reme-web.beapp.workers.dev/" },
  })
})

it("goes home without WorkOS when no session is left, as after deletion", async () => {
  getAuth.mockResolvedValueOnce({ user: null })
  const { signOutHere } = await import("./sign-out")
  await expect(signOutHere()).rejects.toMatchObject({
    options: { to: "/" },
  })
  expect(signOut).not.toHaveBeenCalled()
})
