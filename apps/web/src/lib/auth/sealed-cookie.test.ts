import { afterEach, beforeEach, expect, it, vi } from "vitest"

/**
 * The flow cookie, sealed and read back through a cookie jar standing in for
 * the request and the response. Integrity is the point: the record names the
 * account the MFA calls act on.
 */

const jar = new Map<
  string,
  { value: string; options: Record<string, unknown> }
>()

vi.mock("@tanstack/react-start/server", () => ({
  getCookie: (name: string) => jar.get(name)?.value,
  setCookie: (name: string, value: string, options: Record<string, unknown>) =>
    jar.set(name, { value, options }),
  deleteCookie: (name: string) => jar.delete(name),
}))

const { clearPending, readPending, setPending, updatePending } = await import(
  "./pending"
)

const flow = {
  step: "mfa_challenge" as const,
  token: "pending",
  userId: "user_01",
  email: "owner@example.com",
}

beforeEach(() => {
  jar.clear()
  vi.stubEnv("WORKOS_COOKIE_PASSWORD", "a".repeat(32))
  vi.stubEnv(
    "WORKOS_REDIRECT_URI",
    "https://app.remeai.co.uk/api/auth/callback"
  )
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

it("reads back what it sealed, from a host-only cookie", async () => {
  await setPending(flow)
  const cookie = jar.get("__Host-reme-auth-flow")
  expect(cookie?.value).not.toContain("user_01")
  expect(cookie?.options).toMatchObject({
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
  })
  expect(await readPending()).toEqual(flow)
})

it("keeps the plain name and drops Secure on local http", async () => {
  vi.stubEnv("WORKOS_REDIRECT_URI", "http://localhost:3000/api/auth/callback")
  await setPending(flow)
  expect(jar.get("reme-auth-flow")?.options.secure).toBe(false)
})

it("refuses a tampered cookie", async () => {
  await setPending(flow)
  const cookie = jar.get("__Host-reme-auth-flow")
  if (!cookie) throw new Error("not written")
  // One character of the ciphertext, which the HMAC covers.
  const parts = cookie.value.split("*")
  parts[4] = (parts[4][0] === "A" ? "B" : "A") + parts[4].slice(1)
  cookie.value = parts.join("*")
  expect(await readPending()).toBeNull()
})

it("refuses a cookie sealed under another password", async () => {
  await setPending(flow)
  vi.stubEnv("WORKOS_COOKIE_PASSWORD", "b".repeat(32))
  expect(await readPending()).toBeNull()
})

it("expires after ten minutes, and an update does not extend it", async () => {
  vi.useFakeTimers()
  await setPending(flow)
  vi.advanceTimersByTime(9 * 60 * 1000)
  await updatePending({ challengeId: "auth_challenge_01" })
  expect((await readPending())?.challengeId).toBe("auth_challenge_01")
  expect(jar.get("__Host-reme-auth-flow")?.options.maxAge).toBe(60)
  vi.advanceTimersByTime(61 * 1000)
  expect(await readPending()).toBeNull()
})

it("is gone once cleared", async () => {
  await setPending(flow)
  await clearPending()
  expect(await readPending()).toBeNull()
})
