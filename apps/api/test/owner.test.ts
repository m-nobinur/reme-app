import { ErrorEnvelope } from "@workspace/contracts"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { bridge, type ChangeInput, routeChange } from "../src/changes.ts"
import worker from "../src/index.ts"
import { etag, orderAttention, unchanged } from "../src/workspace.ts"
import { cookieHeader, env, stubJwksFetch } from "./sealed-session.ts"

/**
 * The owner routes' pure halves: where a change goes, the workspace tag, and
 * refusals that happen before any database or binding is touched.
 */

const A = "00000000-0000-4000-8000-00000000000a"
const B = "00000000-0000-4000-8000-00000000000b"
const R = "00000000-0000-4000-8000-0000000000aa"

const site = (over: Partial<ChangeInput> = {}): ChangeInput => ({
  live: false,
  builds: [],
  reviews: [],
  ...over,
})

describe("routeChange, row by row", () => {
  it("builds an unpublished site with nothing running", () => {
    expect(routeChange(site())).toEqual({ route: "build" })
  })

  it("revises a live site with nothing running", () => {
    expect(routeChange(site({ live: true }))).toEqual({ route: "revise" })
  })

  it("steers a build that is still working", () => {
    for (const state of [
      "briefing",
      "planning",
      "implementing",
      "validating",
      "repairing",
      "revising",
    ] as const) {
      expect(
        routeChange(site({ builds: [{ assignment_id: A, state }] }))
      ).toEqual({ route: "steer", assignment_id: A })
    }
  })

  it("steers the build waiting on an answer, ahead of everything else", () => {
    expect(
      routeChange(
        site({
          live: true,
          builds: [
            { assignment_id: A, state: "awaiting_review" },
            { assignment_id: B, state: "blocked_on_information" },
          ],
          reviews: [{ assignment_id: A, revision_id: R }],
        })
      )
    ).toEqual({ route: "steer", assignment_id: B })
  })

  it("turns down an open review, then builds or revises", () => {
    const reviewing = {
      builds: [{ assignment_id: A, state: "awaiting_review" as const }],
      reviews: [{ assignment_id: A, revision_id: R }],
    }
    expect(routeChange(site(reviewing))).toEqual({
      route: "replace",
      via: "reject",
      assignment_id: A,
      revision_id: R,
      rebuild: "site.build",
    })
    expect(routeChange(site({ ...reviewing, live: true }))).toMatchObject({
      route: "replace",
      via: "reject",
      rebuild: "site.revise",
    })
  })

  it("turns down a review the sweep parked", () => {
    expect(
      routeChange(
        site({
          builds: [{ assignment_id: A, state: "blocked_on_approval" }],
          reviews: [{ assignment_id: A, revision_id: R }],
        })
      )
    ).toMatchObject({ route: "replace", via: "reject", assignment_id: A })
  })

  it("waits out a review that expired before the sweep parked it", () => {
    // `readApprovals` hides it: the orchestrator refuses a decision on it
    // until the hourly sweep parks the build.
    expect(
      routeChange(
        site({ builds: [{ assignment_id: A, state: "awaiting_review" }] })
      )
    ).toEqual({ route: "refuse", reason: "build_busy", assignment_id: A })
  })

  it("cancels a build parked on its budget", () => {
    expect(
      routeChange(
        site({ builds: [{ assignment_id: A, state: "blocked_on_approval" }] })
      )
    ).toMatchObject({ route: "replace", via: "cancel", assignment_id: A })
  })

  it("ignores an open review whose build has finished", () => {
    expect(
      routeChange(
        site({
          live: true,
          reviews: [{ assignment_id: A, revision_id: R }],
        })
      )
    ).toEqual({ route: "revise" })
  })

  it("refuses a build that is settling on its own", () => {
    for (const state of [
      "queued",
      "preview_ready",
      "release_candidate",
      "paused",
    ] as const) {
      expect(
        routeChange(site({ builds: [{ assignment_id: A, state }] }))
      ).toEqual({ route: "refuse", reason: "build_busy", assignment_id: A })
    }
  })

  it("steers the working build when a newer one is queued behind it", () => {
    expect(
      routeChange(
        site({
          builds: [
            { assignment_id: B, state: "queued" },
            { assignment_id: A, state: "implementing" },
          ],
        })
      )
    ).toEqual({ route: "steer", assignment_id: A })
  })
})

describe("attention order", () => {
  it("puts approvals, then questions, then alerts, then reports", () => {
    const logged = { assignment_id: null, at: "2026-09-26T00:00:00.000Z" }
    const approval = { kind: "approval" } as never
    const question = { kind: "question" } as never
    const alert = {
      kind: "alert",
      event_id: "2",
      reason: "build_failed",
      ...logged,
    } as const
    const report = {
      kind: "report",
      event_id: "1",
      what: "published",
      revision: { revision_id: R, version: 1 },
      ...logged,
    } as const
    expect(
      orderAttention([approval], [question], [report, alert]).map((i) => i.kind)
    ).toEqual(["approval", "question", "alert", "report"])
  })
})

describe("the workspace tag", () => {
  it("is the same for the same body and differs for another", async () => {
    const one = await etag('{"a":1}')
    expect(await etag('{"a":1}')).toBe(one)
    expect(await etag('{"a":2}')).not.toBe(one)
    expect(one).toMatch(/^"[0-9a-f]{32}"$/)
    // The first 32 hex digits of the body's SHA-256, pinned so a change to
    // the hashing changes every tag a browser holds only on purpose.
    expect(one).toBe('"015abd7f5cc57a2dd94b7590f04ad808"')
  })

  it("carries the chat's newest message after a dot, as the chat reads it back", async () => {
    expect(await etag('{"a":1}', "msg_9")).toBe(
      '"015abd7f5cc57a2dd94b7590f04ad808.msg_9"'
    )
    expect(await etag('{"a":1}', null)).toBe(await etag('{"a":1}'))
  })

  it("matches If-None-Match lists and weak forms, and nothing else", () => {
    expect(unchanged('"x"', '"x"')).toBe(true)
    expect(unchanged('"y", W/"x"', '"x"')).toBe(true)
    expect(unchanged('"y"', '"x"')).toBe(false)
    expect(unchanged(null, '"x"')).toBe(false)
  })
})

describe("owner routes refuse before the database", () => {
  it("refuses an impersonated signup, and passes HEAD through", async () => {
    const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext
    const headers = await cookieHeader(
      { sub: "user_probe_impersonated" },
      { impersonator: { email: "admin@probe.invalid", reason: null } }
    )
    const call = (method: string) =>
      worker.fetch(
        new Request("http://api.invalid/org", {
          method,
          headers: { ...headers, "idempotency-key": "k" },
          body: method === "POST" ? "{}" : undefined,
        }),
        env("postgresql://127.0.0.1:1/none"),
        ctx
      )
    const post = await call("POST")
    expect(post.status).toBe(403)
    expect(ErrorEnvelope.parse(await post.json()).code).toBe(
      "owner.impersonated"
    )
    // HEAD reaches the org resolver, which answers 403 for a session with
    // no organisation: not the impersonation refusal.
    const head = await call("HEAD")
    expect(head.status).toBe(403)
    expect(ErrorEnvelope.parse(await head.json()).code).toBe("org.unresolved")
  })

  let realFetch: typeof fetch
  beforeAll(() => {
    realFetch = globalThis.fetch
    globalThis.fetch = stubJwksFetch()
  })
  afterAll(() => {
    globalThis.fetch = realFetch
  })

  const calls: Request[] = []
  const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext

  it.each([
    ["GET", "/workspace"],
    ["GET", "/facts"],
    ["POST", "/facts"],
    ["POST", "/changes"],
    ["GET", "/activity"],
    ["POST", `/builds/${A}/answer`],
    ["POST", `/builds/${A}/cancel`],
    ["GET", `/builds/${A}/preview`],
    ["POST", `/approvals/${A}/decision`],
  ])("%s %s with no session is 401", async (method, path) => {
    const response = await worker.fetch(
      new Request(`http://api.invalid${path}`, { method }),
      {
        ...env("postgresql://127.0.0.1:1/none"),
        ORCHESTRATOR: { fetch: (r: Request) => calls.push(r) },
      } as unknown as Env,
      ctx
    )
    expect(response.status).toBe(401)
    expect(ErrorEnvelope.parse(await response.json()).code).toBe(
      "session.absent"
    )
    expect(calls).toHaveLength(0)
  })
})

describe("the bridge", () => {
  const owner = {
    orgId: A,
    session: { workosUserId: "user_probe", sessionId: "session_probe" },
  } as Parameters<typeof bridge>[1]

  it("gives a call with no deadline its own 10 s, and answers 503 transient", async () => {
    // The real 10 s, asserted, then run as 20 ms so the case is quick.
    const timeout = AbortSignal.timeout.bind(AbortSignal)
    const asked: number[] = []
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      asked.push(ms)
      return timeout(20)
    })
    const sent: Request[] = []
    try {
      const result = await bridge(
        {
          ORCHESTRATOR: {
            fetch: (request: Request) => {
              sent.push(request)
              return new Promise<never>(() => undefined)
            },
          },
        } as unknown as Env,
        owner,
        `/${A}/cancel`,
        { key: "k" }
      )
      expect(asked).toEqual([10_000])
      expect(result.status).toBe(503)
      expect(ErrorEnvelope.parse(result.body)).toMatchObject({
        class: "transient",
        code: "orchestrator.timeout",
      })
      // The call itself is cancelled, not only given up on.
      expect(sent[0]?.signal.aborted).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it("answers 503 transient when the binding rejects the call", async () => {
    const result = await bridge(
      {
        ORCHESTRATOR: {
          fetch: async () => {
            throw new TypeError("Network connection lost.")
          },
        },
      } as unknown as Env,
      owner,
      `/${A}/cancel`,
      { key: "k" }
    )
    expect(result.status).toBe(503)
    expect(ErrorEnvelope.parse(result.body)).toMatchObject({
      class: "transient",
      code: "orchestrator.unavailable",
    })
  })

  it("takes its listener off a shared signal once the call settles", async () => {
    const shared = new AbortController()
    const removed = vi.spyOn(shared.signal, "removeEventListener")
    await bridge(
      {
        ORCHESTRATOR: { fetch: async () => Response.json({}) },
      } as unknown as Env,
      owner,
      `/${A}/preview`,
      { method: "GET", signal: shared.signal }
    )
    expect(removed).toHaveBeenCalledWith("abort", expect.any(Function))
  })

  it.each([
    ["/", "/assignments/"],
    ["/site/takedown", "/assignments/site/takedown"],
  ])(
    "logs a call to %s by its own route, naming no build",
    async (path, route) => {
      const logged = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined)
      try {
        await bridge(
          {
            ORCHESTRATOR: { fetch: () => Promise.reject(new TypeError()) },
          } as unknown as Env,
          owner,
          path,
          { key: "k" }
        )
        expect(logged.mock.calls).toEqual([
          [
            JSON.stringify({
              code: "orchestrator.unavailable",
              route,
              assignment_id: null,
            }),
          ],
        ])
      } finally {
        logged.mockRestore()
      }
    }
  )

  it.each([
    [
      "a timeout",
      () => new Promise<never>(() => undefined),
      "orchestrator.timeout",
    ],
    [
      "a rejected call",
      () => Promise.reject(new TypeError("Network connection lost.")),
      "orchestrator.unavailable",
    ],
    [
      "a bare 500",
      async () => new Response("upstream broke", { status: 500 }),
      "orchestrator.unavailable",
    ],
    [
      "an enveloped 5xx",
      async () =>
        Response.json(
          {
            class: "provider",
            code: "sandbox.down",
            message: "Down.",
            detail: {},
            occurred_at: new Date().toISOString(),
          },
          { status: 502 }
        ),
      "sandbox.down",
    ],
  ] as const)(
    "logs %s by its code, route and build, and nothing else",
    async (_name, answer, code) => {
      const timeout = AbortSignal.timeout.bind(AbortSignal)
      const spy = vi
        .spyOn(AbortSignal, "timeout")
        .mockImplementation(() => timeout(20))
      const logged = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined)
      try {
        await bridge(
          { ORCHESTRATOR: { fetch: answer } } as unknown as Env,
          owner,
          `/${A}/cancel`,
          { key: "k" }
        )
        expect(logged.mock.calls).toEqual([
          [
            JSON.stringify({
              code,
              route: "/assignments/:id/cancel",
              assignment_id: A,
            }),
          ],
        ])
      } finally {
        logged.mockRestore()
        spy.mockRestore()
      }
    }
  )
})
