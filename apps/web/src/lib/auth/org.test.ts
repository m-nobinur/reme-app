import { afterEach, beforeEach, describe, expect, it } from "vitest"

/**
 * What signup actually puts on the wire to `apps/api`.
 *
 * The interesting assertions are about the request, not the response: an
 * `org_id` in the body would be R3's headline failure, an idempotency key that
 * changed per attempt would make a retried signup produce a second tenant, and
 * a missing cookie would make the API answer 401 before it read anything.
 *
 * `fetch` is stubbed once and serves both calls the path makes: the org write,
 * and the WorkOS memberships list that follows it. Nothing here reaches the
 * network, and a call to a URL this stub does not know throws rather than
 * passing quietly.
 */

const API = "http://api.test.invalid"
const SEALED = "Fe26.2*1*sealed-session-stand-in*~2"
const USER = "user_01TESTPROBE"

type Call = { url: string; init: RequestInit }

let calls: Call[]
let realFetch: typeof fetch

function stub(memberships: Array<{ organization_id: string }>): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString()
    calls.push({ url, init })
    if (url === `${API}/org`) {
      return Response.json(
        {
          org_id: "6f1e6b3a-3f0e-4a3b-9d21-0b5f4a2c8e11",
          slug: "sparkle-clean-6f1e6b3a",
          name: "Sparkle Clean",
          created_at: new Date().toISOString(),
        },
        { status: 201 }
      )
    }
    if (
      url.startsWith(
        "https://api.workos.com/user_management/organization_memberships"
      )
    ) {
      return Response.json({
        object: "list",
        data: memberships,
        list_metadata: { before: null, after: null },
      })
    }
    throw new Error(`the tests do not reach the network: ${url}`)
  }) as typeof fetch
}

beforeEach(() => {
  calls = []
  realFetch = globalThis.fetch
  process.env.REME_API_URL = API
  // The client needs a non-empty key to construct. No case here reaches WorkOS
  // with it, and a key-shaped literal in a committed file is what the pre-commit
  // scan refuses (R9).
  process.env.WORKOS_API_KEY = "unused"
  process.env.WORKOS_CLIENT_ID = "client_org_write_tests"
  process.env.WORKOS_COOKIE_PASSWORD = "z".repeat(32)
})

afterEach(() => {
  globalThis.fetch = realFetch
})

async function write(name = "Sparkle Clean") {
  const { createOrgForSession } = await import("./org")
  return createOrgForSession({
    sealedSession: SEALED,
    workosUserId: USER,
    name,
  })
}

describe("the org write signup sends", () => {
  it("carries the name, the session cookie and a key that survives a retry", async () => {
    globalThis.fetch = stub([])
    await write()
    await write()

    const writes = calls.filter((call) => call.url === `${API}/org`)
    expect(writes).toHaveLength(2)
    for (const call of writes) {
      expect(call.init.method).toBe("POST")
      expect(JSON.parse(call.init.body as string)).toEqual({
        name: "Sparkle Clean",
      })
      expect(new Headers(call.init.headers).get("cookie")).toBe(
        `wos-session=${encodeURIComponent(SEALED)}`
      )
    }
    // The same person twice is the same key, which is what makes the second
    // attempt adopt the first attempt's organization instead of making one.
    const keys = writes.map((call) =>
      new Headers(call.init.headers).get("idempotency-key")
    )
    expect(keys[0]).toBe(keys[1])
    expect(keys[0]).toContain(USER)
  })

  it("names no organisation, in any spelling", async () => {
    globalThis.fetch = stub([])
    await write()
    const [call] = calls
    const sent = `${call.url} ${call.init.body} ${JSON.stringify(call.init.headers ?? {})}`
    // The tenant is resolved server-side from the session (R3, ADR-029). The
    // only identifier on this request is the person's own sealed cookie.
    for (const spelling of [
      "org_id",
      "orgId",
      "organization_id",
      "organizationId",
      "organisation",
      "tenant",
    ]) {
      expect(sent, spelling).not.toContain(spelling)
    }
  })

  it("fails, for the caller to keep the name and retry, when apps/api answers busy", async () => {
    // What `apps/api` answers while another signup for the person is still
    // running (`SignupBusy`): its 503 for anything it did not finish.
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      calls.push({ url: String(input), init: init ?? {} })
      return Response.json(
        {
          error: {
            class: "transient",
            code: "request.failed",
            message: "The request could not be completed.",
            detail: {},
          },
        },
        { status: 503 }
      )
    }) as typeof fetch
    await expect(write()).rejects.toThrow("503")
    // No refresh into an organisation that may not exist yet.
    expect(calls.map((call) => call.url)).toEqual([`${API}/org`])
  })

  it("refuses a name the contract would refuse, before the request", async () => {
    globalThis.fetch = stub([])
    await expect(write("")).rejects.toThrow()
    await expect(write("x".repeat(121))).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})

describe("the session the write hands back", () => {
  it("is unchanged when WorkOS reports no membership to switch into", async () => {
    // Not a refresh into nothing: a refresh needs an organisation, and writing
    // an empty cookie would sign the person out. The old session is the worse
    // answer only in that it still has no org claim.
    globalThis.fetch = stub([])
    expect(await write()).toBe(SEALED)
    expect(
      calls.some((call) => call.url.includes("/user_management/authenticate"))
    ).toBe(false)
  })

  it("is not written from a refresh that failed", async () => {
    // The trap this whole path is built around. A terminal refresh returns no
    // `sealedSession`, and a caller that writes the result regardless writes
    // `undefined` into the cookie, which `apps/api` then answers 401
    // `session.absent` on, which is also its answer to a request with no cookie,
    // so the reason never reaches whoever is debugging it.
    globalThis.fetch = stub([{ organization_id: "org_01TESTORG" }])
    // There is a membership to switch into, so the refresh is attempted. It
    // fails, because the session handed in is not one this password can
    // unseal, and a failed refresh carries no `sealedSession`.
    expect(await write()).toBe(SEALED)
  })
})
