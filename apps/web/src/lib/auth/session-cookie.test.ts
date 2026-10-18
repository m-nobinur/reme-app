import { CookieSessionStorage } from "@workos/authkit-session"
import { afterEach, expect, it, vi } from "vitest"
import { sessionCookie } from "./workos"

/**
 * The session cookie a browser keeps. A `__Host-` cookie is dropped unless it
 * is `Secure`, has `Path=/` and has no `Domain`, so the header the kit writes
 * under the name is checked, not only the name.
 */

afterEach(() => {
  vi.unstubAllEnvs()
})

/** The kit's cookie writer; only reading is left to each framework. */
class Storage extends CookieSessionStorage<Request, Response> {
  getCookie = async () => null
}

const header = async (redirectUri: string) => {
  vi.stubEnv("WORKOS_REDIRECT_URI", redirectUri)
  const storage = new Storage({
    cookieName: sessionCookie(),
    redirectUri,
  } as never)
  const { headers } = (await storage.saveSession(undefined, "sealed")) as {
    headers: Record<string, string>
  }
  return headers["Set-Cookie"]
}

it("is a host-only cookie a sibling host cannot plant, on https", async () => {
  const cookie = await header("https://preview.remeai.co.uk/api/auth/callback")
  expect(cookie.startsWith("__Host-wos-session=sealed;")).toBe(true)
  expect(cookie).toMatch(/; Secure/i)
  expect(cookie).toMatch(/; Path=\/(;|$)/)
  expect(cookie).not.toMatch(/Domain=/i)
})

it("keeps the plain name on local http, where the kit leaves Secure off", async () => {
  const cookie = await header("http://localhost:3000/api/auth/callback")
  expect(cookie.startsWith("wos-session=sealed;")).toBe(true)
  expect(cookie).not.toMatch(/; Secure/i)
})
