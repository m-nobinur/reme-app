import { sessionEncryption } from "@workos/authkit-session"
import { expect, it } from "vitest"
import { whyNoUser } from "./diagnose"

/**
 * The reason a cookie-bearing request found no user, logged with no secret
 * in it: not the cookie, not a token, not the user.
 */

const secret = () => crypto.randomUUID() + crypto.randomUUID()

/** A token whose `exp` is `seconds` from now, unsigned: only `exp` is read. */
const token = (seconds: number) =>
  `h.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + seconds, sid: "session_x" }))}.s`

const request = (cookie: string) =>
  new Request("https://pr-141-reme-web.beapp.workers.dev/api/chat", {
    headers: { cookie: `theme=dark; wos-session=${cookie}` },
  })

it("names a failed unseal, with the path and the cookie's length and nothing secret", async () => {
  const session = {
    accessToken: token(-60),
    refreshToken: secret(),
    user: { id: "user_secret_id" },
  }
  // Sealed under one password and read under another, as a Worker with a
  // rotated cookie password would.
  const cookie = await sessionEncryption.sealData(session, {
    password: secret(),
  })
  const { reason } = await whyNoUser(request(cookie), {
    getSession: async () =>
      await sessionEncryption.unsealData(cookie, { password: secret() }),
    refreshSession: async () => {
      throw new Error("not reached")
    },
  } as never)

  expect(reason).toEqual({
    event: "auth.no_user",
    class: "unseal_failed",
    path: "/api/chat",
    cookie_length: cookie.length,
  })
  const line = JSON.stringify(reason)
  for (const value of [
    cookie,
    session.accessToken,
    session.refreshToken,
    session.user.id,
  ]) {
    expect(line).not.toContain(value)
  }
})

it("names a refused refresh with WorkOS's code, and a missing cookie", async () => {
  const expired = {
    accessToken: token(-60),
    refreshToken: secret(),
    user: { id: "u" },
  }
  const refused = Object.assign(new Error("Failed to refresh tokens"), {
    cause: { error: "invalid_grant", status: 400 },
  })
  expect(
    await whyNoUser(request("sealed"), {
      getSession: async () => expired,
      refreshSession: async () => {
        throw refused
      },
    } as never)
  ).toMatchObject({
    reason: { class: "refresh_failed", code: "invalid_grant" },
  })
  expect(
    await whyNoUser(request("sealed"), {
      getSession: async () => null,
      refreshSession: async () => undefined,
    } as never)
  ).toMatchObject({ reason: { class: "cookie_absent", cookie_length: 6 } })
  // A live token that still found no user is not a refresh problem.
  expect(
    await whyNoUser(request("sealed"), {
      getSession: async () => ({ ...expired, accessToken: token(300) }),
      refreshSession: async () => undefined,
    } as never)
  ).toMatchObject({ reason: { class: "unknown" } })
})
