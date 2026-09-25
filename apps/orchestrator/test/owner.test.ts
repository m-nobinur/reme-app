import { assignments, events, facts, sql } from "@workspace/db"
import { afterAll, describe, expect, it, vi } from "vitest"
import { appendEvent } from "../src/state.ts"
import { freshOrg, newAssignment, ownerOrg } from "./fixture.ts"

// The entrypoint base comes from workerd; here it is the two fields
// `OwnerApi` reads. The rest are stood in for as in the publish suite.
vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    ctx: unknown
    env: unknown
    constructor(context: unknown, bindings: unknown) {
      this.ctx = context
      this.env = bindings
    }
  },
  WorkflowEntrypoint: class {},
}))
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}))
vi.mock("@cloudflare/sandbox", () => ({
  Sandbox: class {},
  ContainerProxy: class {},
}))
vi.mock("../src/sandbox.ts", () => ({
  NPM_REGISTRY_HOST: "registry.npmjs.org",
  SLEEP_AFTER: "5m",
  PoolExhaustedError: class PoolExhaustedError extends Error {},
  endSandbox: async () => undefined,
  sandboxFor: () => ({ destroy: async () => undefined }),
}))
vi.mock("../src/agents/developer.ts", () => ({ Developer: {} }))
// A steer dispatches to the Developer's Durable Object; here it only records.
vi.mock("@workspace/facade", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/facade")>()),
  init: () => ({ dispatch: async () => ({ submissionId: "s" }) }),
}))

const { OwnerApi } = await import("../src/cloudflare.ts")
const { default: consoleApp } = await import("../src/app.ts")
const { requestReview } = await import("../src/publish.ts")
const { advance } = await import("../src/state.ts")
const { kit, previewed } = await import("./site.ts")

/**
 * Owner mode against a real database, through the `OwnerApi` entrypoint the
 * service binding reaches, never through the default export.
 */
const url = process.env.DATABASE_URL
const env = {
  ORCHESTRATOR_TOKEN: "test-token",
  PREVIEW_KEY: "preview-key-for-this-suite-only",
  SITE_HOST_SUFFIX: "-stg.remeai.co.uk",
  HYPERDRIVE: { connectionString: url ?? "postgres://stub" },
  ASSIGNMENTS: {
    create: async ({ id }: { id: string }) => ({ id }),
    get: async () => ({
      sendEvent: async () => undefined,
      terminate: async () => undefined,
    }),
  },
  PUBLISHES: { create: async () => ({}) },
} as unknown as Env

const USER = "user_owner_probe"
const SESSION = "session_owner_probe"
const as = (orgId: string) => ({
  "x-reme-org-id": orgId,
  "x-reme-workos-user-id": USER,
  "x-reme-session-id": SESSION,
})

/** A request as `apps/api` builds it, sent to the entrypoint. */
function owner(
  orgId: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
) {
  const api = new OwnerApi(undefined as never, env)
  return api.fetch(
    new Request(`https://orchestrator/assignments${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...as(orgId),
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  )
}

const created = (orgId: string, assignmentId: string) =>
  kit.withOrg({ orgId }, async (db) => {
    const [row] = await db
      .select({ payload: events.payload })
      .from(events)
      .where(
        sql`${events.assignmentId} = ${assignmentId} and ${events.type} = 'assignment.created'`
      )
    return row?.payload
  })

const taintOf = (orgId: string, assignmentId: string, type: string) =>
  kit.withOrg({ orgId }, async (db) => {
    const [row] = await db
      .select({ taint: events.taint })
      .from(events)
      .where(
        sql`${events.assignmentId} = ${assignmentId} and ${events.type} = ${type}`
      )
    return row?.taint
  })

const live = describe.skipIf(!url)
afterAll(() => kit.close())

describe("the owner entrypoint", () => {
  it("answers a console-only path with the typed 404 envelope", async () => {
    for (const path of ["/facts", "/x/events", "/rollback", "/x/nothing"]) {
      const res = await owner(crypto.randomUUID(), path)
      expect(res.status, path).toBe(404)
      expect(await res.json()).toMatchObject({
        class: "resource",
        code: "route.not_found",
      })
    }
  })
})

live("an owner starting a build", () => {
  it("gets 201 on an org whose only staff are the starting team, as the owner", async () => {
    const { orgId } = await ownerOrg(kit)
    const res = await owner(orgId, "/", {
      goal: "Build my site",
      model: "B",
      withhold: ["business.phone"],
    })
    expect(res.status).toBe(201)
    const row = (await res.json()) as { assignment_id: string; org_id: string }
    expect(row.org_id).toBe(orgId)
    // The console's test levers are not the owner's.
    expect(await created(orgId, row.assignment_id)).toMatchObject({
      origin: "owner",
      model: "A",
      withhold: [],
    })
    // The goal is the owner's own words, so the log marks it untrusted.
    expect(
      await taintOf(orgId, row.assignment_id, "assignment.created")
    ).toEqual(["untrusted_input"])
  })

  it("taints an owner's steer and leaves the console's alone", async () => {
    const { orgId, slug } = await ownerOrg(kit)
    const ids = await newAssignment(kit, orgId)
    const steered = await owner(orgId, `/${ids.assignmentId}/steer`, {
      message: "Make the header green",
    })
    expect(steered.status).toBe(202)
    const res = await consoleApp.request(
      `/assignments/${ids.assignmentId}/steer?org=${slug}`,
      {
        method: "POST",
        headers: { authorization: "Bearer test-token" },
        body: JSON.stringify({ message: "Use the brand blue" }),
      },
      env
    )
    expect(res.status).toBe(202)
    const rows = await kit.withOrg({ orgId }, (db) =>
      db
        .select({ payload: events.payload, taint: events.taint })
        .from(events)
        .where(
          sql`${events.assignmentId} = ${ids.assignmentId} and ${events.type} = 'assignment.steered'`
        )
        .orderBy(events.eventId)
    )
    expect(rows).toEqual([
      {
        payload: { message: "Make the header green" },
        taint: ["untrusted_input"],
      },
      { payload: { message: "Use the brand blue" }, taint: [] },
    ])
  })

  it("acts on the header's org, whatever ?org= and the bearer say", async () => {
    const { orgId } = await ownerOrg(kit)
    const other = await freshOrg(kit)
    const slug = `state-test-${other.slice(0, 8)}`
    const res = await owner(
      orgId,
      `/?org=${slug}`,
      { goal: "Build my site" },
      { authorization: "Bearer test-token" }
    )
    expect(res.status).toBe(201)
    expect(((await res.json()) as { org_id: string }).org_id).toBe(orgId)
    const theirs = await kit.withOrg({ orgId: other }, (db) =>
      db.select().from(assignments)
    )
    expect(theirs).toEqual([])
  })

  it("records a console build as the console's", async () => {
    const orgId = await freshOrg(kit)
    const res = await consoleApp.request(
      `/assignments?org=state-test-${orgId.slice(0, 8)}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "idempotency-key": crypto.randomUUID(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "B" }),
      },
      env
    )
    expect(res.status).toBe(201)
    const { assignment_id } = (await res.json()) as { assignment_id: string }
    expect(await created(orgId, assignment_id)).toMatchObject({
      origin: "console",
      model: "B",
    })
  })

  it("stops the owner at 20 of their own builds in 24 hours, after replaying a key it has seen", async () => {
    const { orgId, slug } = await ownerOrg(kit)
    const byConsole = () =>
      consoleApp.request(
        `/assignments?org=${slug}`,
        {
          method: "POST",
          headers: {
            authorization: "Bearer test-token",
            "idempotency-key": crypto.randomUUID(),
          },
        },
        env
      )
    // Console and harness builds on the same org use none of the allowance.
    for (let i = 0; i < 5; i++) expect((await byConsole()).status).toBe(201)
    for (let i = 0; i < 19; i++) {
      expect((await owner(orgId, "/", {})).status).toBe(201)
    }
    const key = { "idempotency-key": crypto.randomUUID() }
    expect((await owner(orgId, "/", {}, key)).status).toBe(201)
    const past = await owner(orgId, "/", {})
    expect(past.status).toBe(429)
    expect(await past.json()).toMatchObject({
      class: "budgetary",
      code: "builds.daily_cap",
    })
    expect((await owner(orgId, "/", {}, key)).status).toBe(200)
    // The console is not the owner, and is not capped.
    expect((await byConsole()).status).toBe(201)
  })
})

live("an owner answering a question", () => {
  async function asked(field: string) {
    const { orgId, ownerStaffId } = await ownerOrg(kit)
    const ids = await newAssignment(kit, orgId)
    for (const to of [
      "briefing",
      "planning",
      "implementing",
      "blocked_on_information",
    ] as const) {
      await advance(kit, ids, to)
    }
    const requestId = crypto.randomUUID()
    await kit.withOrg({ orgId }, (db) =>
      appendEvent(db, {
        orgId,
        assignmentId: ids.assignmentId,
        staffId: null,
        type: "information.requested",
        payload: { request_id: requestId, field },
      })
    )
    const answer = (value: unknown) =>
      owner(orgId, `/${ids.assignmentId}/answer`, {
        request_id: requestId,
        value,
      })
    return { orgId, ownerStaffId, answer }
  }

  const current = (orgId: string, key: string) =>
    kit.withOrg({ orgId }, async (db) => {
      const [row] = await db
        .select()
        .from(facts)
        .where(sql`${facts.key} = ${key} and ${facts.validTo} is null`)
      return row
    })

  it("takes a FactValue key's value as that key's shape, verified by the owner", async () => {
    const { orgId, ownerStaffId, answer } = await asked("hours.weekday")
    for (const bad of [
      { open: "25:00", close: "17:00" },
      { open: "09:00" },
      '{"open":"09:00","close":"17:00"}',
      "9 to 5",
    ]) {
      const res = await answer(bad)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({
        class: "validation",
        code: "answer.invalid",
        detail: { field: "hours.weekday" },
      })
    }
    expect(await current(orgId, "hours.weekday")).toBeUndefined()
    const res = await answer({ open: "08:00", close: "18:00" })
    expect(res.status).toBe(202)
    expect(await current(orgId, "hours.weekday")).toMatchObject({
      value: { open: "08:00", close: "18:00" },
      provenanceSource: "owner_stated",
      verifiedByStaffId: ownerStaffId,
    })
  })

  it("takes any other key's value as 1 to 500 characters of text, uncoerced", async () => {
    const { orgId, answer } = await asked("business.parking")
    for (const bad of [{ spaces: 2 }, 2, "", "   ", "x".repeat(501)]) {
      expect((await answer(bad)).status).toBe(400)
    }
    // Text that looks like JSON is still the text the owner typed.
    for (const text of ["Street parking", "[1,2]", "123", "null"]) {
      expect((await answer(text)).status).toBe(202)
      expect((await current(orgId, "business.parking"))?.value).toBe(text)
    }
  })
})

live("an owner deciding a review", () => {
  it("records the decision as the owner's session, with no console gate", async () => {
    const built = await previewed()
    await requestReview(kit, built.ids)
    const res = await owner(built.orgId, `/${built.ids.assignmentId}/approve`, {
      revision_id: built.revisionId,
    })
    expect(res.status).toBe(202)
    expect(await res.json()).toMatchObject({
      decision: "approved",
      decided_by: { kind: "owner_session", user_id: USER, session_id: SESSION },
    })
    // The same Worker still refuses the console.
    const refused = await consoleApp.request(
      `/assignments/${built.ids.assignmentId}/approve?org=state-test-${built.orgId.slice(0, 8)}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({ revision_id: built.revisionId }),
      },
      env
    )
    expect(refused.status).toBe(403)
  })

  it("records a rejection as the owner's session", async () => {
    const built = await previewed()
    await requestReview(kit, built.ids)
    const res = await owner(built.orgId, `/${built.ids.assignmentId}/reject`, {
      revision_id: built.revisionId,
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({
      decision: "rejected",
      decided_by: { kind: "owner_session", user_id: USER, session_id: SESSION },
    })
  })
})
