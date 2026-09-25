import { WorkOS } from "@workos-inc/node"
import { ErrorEnvelope } from "@workspace/contracts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import worker from "../src/index.ts"
import { readSession } from "../src/session.ts"
import {
  CLIENT_ID,
  COOKIE_PASSWORD,
  cookieHeader,
  env,
  OTHER_PASSWORD,
  sessionCookie,
  stubJwksFetch,
} from "./sealed-session.ts"

/**
 * The auth negative cases that need no database: a session that has expired, a
 * cookie somebody made up, and a cookie that unseals to nothing.
 *
 * Every one is a real request through `worker.fetch`, refused by the real
 * reader. See `sealed-session.ts` for the one thing that is not real, the
 * signing key, and why swapping that and only that is what makes these cases
 * mean anything.
 *
 * The database is a port nothing listens on. `postgres` connects lazily, so a
 * case that ever got past the session check would fail to connect rather than
 * pass, and "refused before it reached the database" is a property of the
 * fixture instead of a comment.
 */

const NOWHERE = "postgresql://127.0.0.1:1/none"

const noted = (error: unknown) => console.error("waitUntil", error)
const ctx = {
  waitUntil: (promise: Promise<unknown>) => void promise.catch(noted),
} as ExecutionContext

const OWNER = { sub: "user_fixture_session_probe", org_id: "org_fixture_probe" }

let realFetch: typeof fetch

beforeAll(() => {
  realFetch = globalThis.fetch
  globalThis.fetch = stubJwksFetch()
})

afterAll(() => {
  globalThis.fetch = realFetch
})

const call = (path: string, init?: RequestInit) =>
  worker.fetch(
    new Request(`http://api.invalid${path}`, init),
    env(NOWHERE),
    ctx
  )

/**
 * The cases below all end in a refusal, and a refusal is worthless as evidence
 * unless the same machinery accepts a good cookie. This is that control: if the
 * seal format drifts from the SDK's, or the JWKS stub stops matching, this fails
 * first and names the reason, rather than every case below passing for the
 * wrong reason.
 */
describe("the harness signs a cookie this SDK accepts", () => {
  const client = new WorkOS("unused", { clientId: CLIENT_ID })

  it("authenticates a well-formed session and reads its claims", async () => {
    const result = await client.userManagement
      .loadSealedSession({
        sessionData: await sessionCookie({ ...OWNER, role: "owner" }),
        cookiePassword: COOKIE_PASSWORD,
      })
      .authenticate()

    expect(result.authenticated, "the harness cookie was refused").toBe(true)
    if (!result.authenticated) return
    expect(result.organizationId).toBe(OWNER.org_id)
    expect(result.user.id).toBe(OWNER.sub)
    expect(result.role).toBe("owner")
  })
})

describe("what a session carries besides the person", () => {
  const read = async (headers: Record<string, string>) =>
    readSession(new Request("http://api.invalid/", { headers }), env(NOWHERE))

  it("names the WorkOS session, from the token's sid", async () => {
    const session = await read(await cookieHeader(OWNER))
    expect(session?.sessionId).toBe(`session_${OWNER.sub}`)
    expect(session?.impersonated).toBe(false)
  })

  it("says so when an admin is signed in as the owner", async () => {
    const session = await read(
      await cookieHeader(OWNER, {
        impersonator: { email: "admin@fixture.invalid", reason: null },
      })
    )
    expect(session?.impersonated).toBe(true)
  })
})

describe("an expired session", () => {
  it("is refused, and refused for having expired", async () => {
    const client = new WorkOS("unused", { clientId: CLIENT_ID })
    // Named rather than inferred from the status code. A 401 also comes back
    // from a missing cookie, and the point of this case is that a session that
    // was once valid stops being one, which only the reason says.
    const result = await client.userManagement
      .loadSealedSession({
        sessionData: await sessionCookie({ ...OWNER, expiresIn: -60 }),
        cookiePassword: COOKIE_PASSWORD,
      })
      .authenticate()
    expect(result.authenticated).toBe(false)
    expect(result.authenticated === false && result.reason).toBe("invalid_jwt")
  })

  it("cannot read the org through the API", async () => {
    for (const path of ["/org", "/staff"]) {
      const response = await call(path, {
        headers: await cookieHeader({ ...OWNER, expiresIn: -60 }),
      })
      expect(response.status, path).toBe(401)
      expect(ErrorEnvelope.parse(await response.json()).code).toBe(
        "session.absent"
      )
    }
  })

  it("expires on its own clock, not on the reader's goodwill", async () => {
    // The same cookie, the same key, the same seal: only `exp` differs, and by
    // one second across the boundary. A reader that took the claims without
    // verifying them would answer both of these the same way.
    const alive = await call("/org", {
      headers: await cookieHeader({ ...OWNER, expiresIn: 120 }),
    })
    const dead = await call("/org", {
      headers: await cookieHeader({ ...OWNER, expiresIn: -1 }),
    })
    // Alive gets past the session and dies at the database, which is the port
    // nothing listens on: a 503, not a 401. That is the assertion that makes
    // the 401 below mean "the session was refused" rather than "nothing works".
    expect(alive.status).toBe(503)
    expect(dead.status).toBe(401)
  })
})

describe("a forged cookie", () => {
  it("is refused when the seal is not ours, and not by a truthy check", async () => {
    // ADR-024: `unsealData` answers a tampered seal with `{}` rather than
    // throwing, so `if (session)` is not a check. This asserts the refusal is
    // named — the SDK saw an empty payload and said so — which is the thing a
    // truthy check would get wrong.
    const client = new WorkOS("unused", { clientId: CLIENT_ID })
    const result = await client.userManagement
      .loadSealedSession({
        sessionData: await sessionCookie(OWNER, { password: OTHER_PASSWORD }),
        cookiePassword: COOKIE_PASSWORD,
      })
      .authenticate()
    expect(result.authenticated).toBe(false)
    expect(result.authenticated === false && result.reason).toBe(
      "invalid_session_cookie"
    )
  })

  it("is refused when the token is signed by a key WorkOS does not publish", async () => {
    // The seal is ours and unseals cleanly, so this gets past the cookie layer
    // and is stopped by the signature. Without it, anyone who learned the
    // cookie password could mint any org_id they liked.
    const response = await call("/org", {
      headers: await cookieHeader(OWNER, { forgeSignature: true }),
    })
    expect(response.status).toBe(401)
    expect(ErrorEnvelope.parse(await response.json()).code).toBe(
      "session.absent"
    )
  })

  it("is refused when the seal is not ours, through the API", async () => {
    for (const path of ["/org", "/staff"]) {
      const response = await call(path, {
        headers: await cookieHeader(OWNER, { password: OTHER_PASSWORD }),
      })
      expect(response.status, path).toBe(401)
    }
  })

  it("cannot be another cookie wearing the name", async () => {
    // Each of these is a value the SDK recognises as not a session and answers
    // for, so each is a clean 401. The truncations below are the ones it does
    // not answer for.
    for (const value of [
      "",
      "null",
      "{}",
      "Fe26.2**deadbeef*~2",
      "not-a-sealed-session",
    ]) {
      const response = await call("/org", {
        headers: { cookie: `wos-session=${encodeURIComponent(value)}` },
      })
      expect(response.status, JSON.stringify(value)).toBe(401)
    }
  })

  it("never becomes a session, however the seal is cut", async () => {
    // The security property, and the one that must hold whatever the status
    // code turns out to be: no truncation of a valid seal yields data. Written
    // separately from the classification below so that fixing the class does
    // not touch the assertion that matters.
    const whole = await sessionCookie(OWNER)
    for (let cut = 1; cut <= 48; cut += 1) {
      const response = await call("/org", {
        headers: {
          cookie: `wos-session=${encodeURIComponent(whole.slice(0, whole.length - cut))}`,
        },
      })
      expect(response.ok, `truncated by ${cut} was accepted`).toBe(false)
      expect(response.status, `truncated by ${cut}`).toBeGreaterThanOrEqual(400)
    }
  })

  it("is called transient when its seal will not decode, which is the wrong class", async () => {
    // A defect, pinned rather than hidden. `unsealData` catches five iron
    // errors by message and rethrows the rest, and a seal cut mid-component
    // fails base64 decoding first: `DOMException: InvalidCharacterError`, which
    // is not on that list. It leaves `authenticate()` as a throw, and the
    // handler's catch answers 503 `request.failed`, class `transient`.
    //
    // Fail-closed, so no session is issued and nothing leaks. Wrong all the
    // same: transient tells the caller to retry, and a corrupt cookie retries
    // forever instead of being told to sign in again, while the misclassified
    // failures land in the server error rate rather than in bad sessions.
    //
    // Not fixed here on purpose. It is `apps/api/src/session.ts`, it belongs to
    // the role that owns that file, and the fix has to keep a JWKS the worker
    // cannot reach as a 503: signing everyone out during a WorkOS outage is
    // worse than saying the request failed. When it lands, this case becomes a
    // 401 `session.absent` and the two below it stop needing to be separate.
    const whole = await sessionCookie(OWNER)
    const response = await call("/org", {
      headers: {
        cookie: `wos-session=${encodeURIComponent(whole.slice(0, whole.length - 4))}`,
      },
    })
    expect(response.status).toBe(503)
    const body = ErrorEnvelope.parse(await response.json())
    expect(body.code).toBe("request.failed")
    expect(body.class).toBe("transient")
  })
})
