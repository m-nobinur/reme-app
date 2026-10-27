import { OWNER_BRIDGE_HEADERS } from "@workspace/contracts"
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

const { default: app, ownerRoutes } = await import("../src/app.ts")
const { Hono } = await import("hono")

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
    const res = await app.request("/sandbox/probe", {}, env)
    expect(res.status).toBe(401)
    expect((await envelope(res)).code).toBe("console.unauthenticated")
  })

  it("guards the staging route restore the same way", async () => {
    const res = await app.request("/domains/routes", { method: "POST" }, env)
    expect(res.status).toBe(401)
    expect((await envelope(res)).code).toBe("console.unauthenticated")
  })

  it("answers a sandbox that throws as a transient 503, which the probe retries", async () => {
    const res = await app.request(
      "/sandbox/probe",
      { headers: { authorization: "Bearer test-token" } },
      env
    )
    expect(res.status).toBe(503)
    expect(await envelope(res)).toMatchObject({
      class: "transient",
      code: "request.failed",
    })
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

  it("wants an idempotency key on review, approve, rollback and steer, before the body", async () => {
    for (const path of [
      "/assignments/x/review",
      "/assignments/x/approve",
      "/assignments/rollback",
      "/assignments/x/steer",
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
        { method: "POST", headers: { ...authed, "idempotency-key": "k" } },
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

  it.each([
    ["fact_keys that is not an array", { fact_keys: "pricing.x" }],
    ["a key that is not a string", { fact_keys: [1] }],
    ["the same key twice", { fact_keys: ["pricing.x", "pricing.x"] }],
    [
      "more keys than one call takes",
      { fact_keys: Array.from({ length: 21 }, (_, i) => `k.${i}`) },
    ],
  ])(
    "site/hidden refuses %s as hidden.malformed, behind the bearer",
    async (_, body) => {
      expect((await post("/assignments/site/hidden", body, {})).status).toBe(
        401
      )
      const res = await post("/assignments/site/hidden", body)
      expect(res.status).toBe(400)
      expect(await envelope(res)).toMatchObject({
        class: "validation",
        code: "hidden.malformed",
      })
    }
  )

  it("site/hidden needs an Idempotency-Key", async () => {
    const res = await app.request(
      "/assignments/site/hidden?org=brightclean",
      {
        method: "POST",
        headers: { ...authed, "content-type": "application/json" },
        body: JSON.stringify({ fact_keys: [] }),
      },
      env
    )
    expect(res.status).toBe(400)
    expect((await envelope(res)).code).toBe("idempotency_key.missing")
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

describe("owner mode", () => {
  // Mounted the way `OwnerApi` mounts it (cloudflare.ts), without workerd.
  const owner = new Hono<{ Bindings: Env }>({ strict: false }).route(
    "/assignments",
    ownerRoutes()
  )
  const ORG = "10000001-0000-4000-8000-000000000000"
  const identity = {
    [OWNER_BRIDGE_HEADERS.orgId]: ORG,
    [OWNER_BRIDGE_HEADERS.workosUserId]: "user_1",
    [OWNER_BRIDGE_HEADERS.sessionId]: "session_1",
  }

  // The seven routes that cross the bridge, the owner's own, and every route
  // the console has besides. A route added to any tree lands in one of these.
  const BRIDGE: [string, string][] = [
    ["POST", "/assignments"],
    ["POST", "/assignments/x/answer"],
    ["POST", "/assignments/x/cancel"],
    ["POST", "/assignments/x/steer"],
    ["GET", "/assignments/x/preview"],
    ["POST", "/assignments/x/approve"],
    ["POST", "/assignments/x/reject"],
  ]
  const OWNER_ONLY: [string, string][] = [
    ["POST", "/assignments/site/takedown"],
  ]
  const CONSOLE_ONLY: [string, string][] = [
    ["GET", "/assignments"],
    ["GET", "/sandbox/probe"],
    ["POST", "/domains/routes"],
    ["POST", "/assignments/x/start"],
    ["GET", "/assignments/facts"],
    ["POST", "/assignments/facts"],
    ["GET", "/assignments/site"],
    ["POST", "/assignments/site/hidden"],
    ["GET", "/assignments/x"],
    ["GET", "/assignments/x/events"],
    ["POST", "/assignments/x/review"],
    ["POST", "/assignments/rollback"],
  ]

  it("is not reachable through the default export with forged owner headers", async () => {
    for (const [method, path] of [...BRIDGE, ...OWNER_ONLY]) {
      const res = await app.request(
        `${path}?org=brightclean`,
        { method, headers: identity },
        env
      )
      expect(res.status).toBe(401)
      expect((await envelope(res)).code).toBe("console.unauthenticated")
    }
  })

  it("refuses a missing or malformed identity, whatever ?org= and the bearer say", async () => {
    const bearer = { authorization: "Bearer test-token" }
    for (const headers of [
      bearer,
      { ...bearer, ...identity, [OWNER_BRIDGE_HEADERS.orgId]: "brightclean" },
      { ...identity, [OWNER_BRIDGE_HEADERS.sessionId]: "" },
      { ...identity, [OWNER_BRIDGE_HEADERS.workosUserId]: " " },
    ]) {
      const res = await owner.request(
        "/assignments/x/answer?org=brightclean",
        { method: "POST", headers },
        env
      )
      expect(res.status).toBe(401)
      expect(await envelope(res)).toMatchObject({
        class: "permission",
        code: "owner.unauthenticated",
      })
    }
  })

  it("answers the bridge routes and 404s every other one", async () => {
    for (const [method, path] of [...BRIDGE, ...OWNER_ONLY]) {
      const res = await owner.request(path, { method, headers: identity }, env)
      expect(res.status, `${method} ${path}`).not.toBe(404)
      expect(res.status, `${method} ${path}`).not.toBe(401)
    }
    for (const [method, path] of CONSOLE_ONLY) {
      const res = await owner.request(path, { method, headers: identity }, env)
      expect(res.status, `${method} ${path}`).toBe(404)
    }
  })

  it("leaves the console every route it had", async () => {
    for (const [method, path] of [...BRIDGE, ...CONSOLE_ONLY]) {
      const res = await app.request(
        `${path}?org=brightclean`,
        { method, headers: { authorization: "Bearer test-token" } },
        env
      )
      expect(res.status, `${method} ${path}`).not.toBe(404)
    }
  })

  it("keeps the owner's own routes off the console's app, bearer or not", async () => {
    for (const [method, path] of OWNER_ONLY) {
      const res = await app.request(
        `${path}?org=brightclean`,
        { method, headers: { authorization: "Bearer test-token" } },
        env
      )
      expect(res.status, `${method} ${path}`).toBe(404)
      expect((await envelope(res)).code).toBe("route.not_found")
    }
  })

  it("skips the console's approval gate for an owner", async () => {
    const res = await owner.request(
      "/assignments/x/approve",
      {
        method: "POST",
        headers: { ...identity, "idempotency-key": "k" },
        body: JSON.stringify({ revision_id: "x" }),
      },
      env
    )
    // Past the gate, into the database this suite does not have.
    expect(res.status).toBe(503)
  })
})

describe("a steer", () => {
  it("refuses a message longer than a goal, from either caller", async () => {
    const body = JSON.stringify({ message: "x".repeat(4001) })
    const console_ = await app.request(
      "/assignments/x/steer?org=brightclean",
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "idempotency-key": "k",
        },
        body,
      },
      env
    )
    const owner = await new Hono<{ Bindings: Env }>()
      .route("/assignments", ownerRoutes())
      .request(
        "/assignments/x/steer",
        {
          method: "POST",
          headers: {
            [OWNER_BRIDGE_HEADERS.orgId]:
              "10000001-0000-4000-8000-000000000000",
            [OWNER_BRIDGE_HEADERS.workosUserId]: "user_1",
            [OWNER_BRIDGE_HEADERS.sessionId]: "session_1",
            "idempotency-key": "k",
          },
          body,
        },
        env
      )
    for (const res of [console_, owner]) {
      expect(res.status).toBe(400)
      expect(await envelope(res)).toMatchObject({
        class: "validation",
        code: "steer.too_long",
      })
    }
  })
})

describe("a path nothing serves", () => {
  it("answers the typed 404 envelope, not plain text", async () => {
    for (const [path, headers] of [
      ["/nowhere", {}],
      [
        "/assignments/x/nothing?org=brightclean",
        { authorization: "Bearer test-token" },
      ],
    ] as const) {
      const res = await app.request(path, { headers }, env)
      expect(res.status).toBe(404)
      expect(await envelope(res)).toMatchObject({
        class: "resource",
        code: "route.not_found",
      })
    }
  })
})
