import { expect, it, vi } from "vitest"

const signOut = vi.fn(async (_options: unknown) => undefined)

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    handler: (run: () => unknown) => () => run(),
  }),
}))
vi.mock("@tanstack/react-start/server", () => ({
  getRequestUrl: () =>
    new URL("https://pr-141-reme-web.beapp.workers.dev/sign-out"),
}))
vi.mock("@workos/authkit-tanstack-react-start", () => ({ signOut }))

it("returns to the home page of the deployment the owner is on", async () => {
  const { signOutHere } = await import("./sign-out")
  await signOutHere()
  expect(signOut).toHaveBeenCalledWith({
    data: { returnTo: "https://pr-141-reme-web.beapp.workers.dev/" },
  })
})
