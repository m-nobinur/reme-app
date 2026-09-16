import { describe, expect, it, vi } from "vitest"

// Past the bearer, every console route resolves the org and opens a tenancy
// kit. Neither needs a database to prove the 501 handlers, so both are stood
// in for; the state suite is where the real ones are driven.
vi.mock("@workspace/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/db")>()),
  tenancy: () => ({
    close: async () => undefined,
    withOrg: async () => {
      throw new Error("no database in this suite")
    },
  }),
  resolveOrgBySlug: async (_kit: unknown, slug: string) =>
    slug === "brightclean" ? "10000001-0000-4000-8000-000000000000" : null,
}))

// The probe reaches a container; nothing in this suite may. The route is
// proven to sit behind the bearer here and driven for real by the probe suite.
vi.mock("../src/sandbox.ts", () => ({
  probe: async () => {
    throw new Error("no container in this suite")
  },
  sandboxFor: () => ({ destroy: async () => undefined }),
}))

// The agent module binds to a Durable Object at import time; the routes that
// dispatch to it stop at the bearer or the row in this suite.
vi.mock("../src/agents/developer.ts", () => ({ Developer: {} }))

const { default: app } = await import("../src/app.ts")

/**
 * The console's edge, without a database: the bearer, the page, and the
 * routes that answer 501 until their story lands. Anything past the bearer
 * needs Hyperdrive and is proven by the state suite and by hand.
 */
const env = {
  ORCHESTRATOR_TOKEN: "test-token",
  HYPERDRIVE: { connectionString: "postgres://stub" },
} as unknown as Env

const envelope = async (res: Response) => {
  const body = (await res.json()) as Record<string, unknown>
  expect(body).toMatchObject({
    class: expect.any(String),
    code: expect.any(String),
    message: expect.any(String),
    detail: expect.any(Object),
    occurred_at: expect.any(String),
  })
  return body
}

describe("the bearer", () => {
  it("refuses a request with no token as a typed 401", async () => {
    const res = await app.request("/assignments?org=brightclean", {}, env)
    expect(res.status).toBe(401)
    expect(await envelope(res)).toMatchObject({
      class: "permission",
      code: "console.unauthenticated",
    })
  })

  it("refuses a wrong token the same way", async () => {
    const res = await app.request(
      "/assignments?org=brightclean",
      { headers: { authorization: "Bearer wrong" } },
      env
    )
    expect(res.status).toBe(401)
    expect((await envelope(res)).code).toBe("console.unauthenticated")
  })

  it("guards the sandbox probe the same way", async () => {
    const res = await app.request(
      "/assignments/sandbox/probe?org=brightclean",
      {},
      env
    )
    expect(res.status).toBe(401)
    expect((await envelope(res)).code).toBe("console.unauthenticated")
  })

  it("fails closed when the Worker has no token at all", async () => {
    const res = await app.request(
      "/assignments?org=brightclean",
      { headers: { authorization: "Bearer test-token" } },
      { ...env, ORCHESTRATOR_TOKEN: "" } as unknown as Env
    )
    expect(res.status).toBe(503)
    expect((await envelope(res)).code).toBe("console.unconfigured")
  })
})

describe("the page", () => {
  it("is served at /console with its FIXME", async () => {
    const res = await app.request("/console", {}, env)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(await res.text()).toContain("FIXME")
  })

  it("may talk only to its own origin and never be framed", async () => {
    const res = await app.request("/console", {}, env)
    const csp = res.headers.get("content-security-policy") ?? ""
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(res.headers.get("referrer-policy")).toBe("no-referrer")
  })
})

describe("creating an assignment", () => {
  it("refuses a goal longer than 4,000 characters before touching a row", async () => {
    const res = await app.request(
      "/assignments?org=brightclean",
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "idempotency-key": "k1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ goal: "x".repeat(4001) }),
      },
      env
    )
    expect(res.status).toBe(400)
    expect(await envelope(res)).toMatchObject({
      class: "validation",
      code: "goal.too_long",
    })
  })
})

describe("the publish routes' edge", () => {
  const authed = { authorization: "Bearer test-token" }

  it("refuses a console approval where the Worker does not allow one", async () => {
    const unauthenticated = await app.request(
      "/assignments/x/approve?org=brightclean",
      { method: "POST" },
      env
    )
    expect(unauthenticated.status).toBe(401)
    const res = await app.request(
      "/assignments/x/approve?org=brightclean",
      {
        method: "POST",
        headers: { ...authed, "idempotency-key": "k" },
        body: JSON.stringify({ revision_id: "x" }),
      },
      env
    )
    expect(res.status).toBe(403)
    expect(await envelope(res)).toMatchObject({
      class: "permission",
      code: "approval.console_forbidden",
    })
  })

  it("wants an idempotency key on review, approve and rollback", async () => {
    for (const path of [
      "/assignments/x/review",
      "/assignments/x/approve",
      "/assignments/rollback",
    ]) {
      const res = await app.request(
        `${path}?org=brightclean`,
        { method: "POST", headers: authed },
        { ...env, CONSOLE_APPROVALS: "allow" } as unknown as Env
      )
      expect(res.status).toBe(400)
      expect(await envelope(res)).toMatchObject({
        code: "idempotency_key.missing",
      })
    }
  })

  it.each([
    ["/assignments/x/answer", "answer.malformed"],
    ["/assignments/x/steer", "steer.empty"],
  ])(
    "%s refuses an empty body as %s, behind the bearer",
    async (path, code) => {
      const unauthenticated = await app.request(
        `${path}?org=brightclean`,
        { method: "POST" },
        env
      )
      expect(unauthenticated.status).toBe(401)

      const res = await app.request(
        `${path}?org=brightclean`,
        { method: "POST", headers: authed },
        env
      )
      expect(res.status).toBe(400)
      expect(await envelope(res)).toMatchObject({ class: "validation", code })
    }
  )

  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = authed
  ) =>
    app.request(
      `${path}?org=brightclean`,
      {
        method: "POST",
        headers: {
          ...headers,
          "idempotency-key": "k1",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      env
    )

  it.each([
    ["no facts", { facts: [] }],
    [
      "too many facts",
      {
        facts: Array.from({ length: 21 }, (_, i) => ({
          key: `k.${i}`,
          value: "v",
        })),
      },
    ],
    ["a key that is not a string", { facts: [{ key: 1, value: "v" }] }],
    ["no value", { facts: [{ key: "business.phone" }] }],
    [
      "a value past 1,000 characters",
      { facts: [{ key: "business.name", value: "x".repeat(1001) }] },
    ],
  ])(
    "facts refuses %s as facts.malformed, behind the bearer",
    async (_, body) => {
      expect((await post("/assignments/facts", body, {})).status).toBe(401)
      const res = await post("/assignments/facts", body)
      expect(res.status).toBe(400)
      expect(await envelope(res)).toMatchObject({
        class: "validation",
        code: "facts.malformed",
      })
    }
  )

  it("follow-up refuses an empty text as follow_up.empty, behind the bearer", async () => {
    const body = { text: "  " }
    expect((await post("/assignments/x/follow-up", body, {})).status).toBe(401)
    const res = await post("/assignments/x/follow-up", body)
    expect(res.status).toBe(400)
    expect(await envelope(res)).toMatchObject({
      class: "validation",
      code: "follow_up.empty",
    })
  })

  it("a slug nothing holds is 404 before any of them", async () => {
    const res = await app.request(
      "/assignments/x/answer?org=nobody",
      { method: "POST", headers: authed },
      env
    )
    expect(res.status).toBe(404)
    expect((await envelope(res)).code).toBe("org.unresolved")
  })
})
