import { isRedirect } from "@tanstack/react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"

const getAuth = vi.hoisted(() => vi.fn())
vi.mock("@workos/authkit-tanstack-react-start", () => ({ getAuth }))

const { leaveIfSignedIn, signedIn } = await import("./signed-in")

describe("the signed-out pages", () => {
  beforeEach(() => getAuth.mockReset())

  it("stay open to someone with no session", async () => {
    getAuth.mockResolvedValue({ user: null })
    expect(await signedIn()).toBe(false)
    await expect(leaveIfSignedIn()).resolves.toBeUndefined()
  })

  it("send a signed-in owner to the app", async () => {
    getAuth.mockResolvedValue({ user: { id: "user_01" } })
    expect(await signedIn()).toBe(true)
    const thrown = await leaveIfSignedIn().catch((error: unknown) => error)
    expect(isRedirect(thrown)).toBe(true)
    expect((thrown as { options: { to: string } }).options.to).toBe("/app")
  })
})
