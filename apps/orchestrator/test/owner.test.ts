import { createHash } from "node:crypto"
import { OWNER_BRIDGE_HEADERS } from "@workspace/contracts"
import {
  appendEvent,
  assignments,
  events,
  facts,
  sql,
  supersedeFact,
} from "@workspace/db"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
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
  endSite: async () => undefined,
  sandboxFor: () => ({ destroy: async () => undefined }),
}))
vi.mock("../src/agents/developer.ts", () => ({ Developer: {} }))
// A steer dispatches to the Developer's Durable Object; here it only records,
// keeping flue's keyed admission (`DispatchRequest.idempotencyKey`): a key
// seen before with the same submission gets its first receipt back and
// delivers nothing, and with any other submission throws
// `SubmissionConflictError`, as flue does.
const { dispatched, admitted, attempts } = vi.hoisted(() => ({
  dispatched: [] as { message: unknown; idempotencyKey?: string }[],
  admitted: new Map<string, { message: string; submissionId: string }>(),
  /** Every dispatch call, admitted or not. */
  attempts: { count: 0 },
}))
vi.mock("@workspace/facade", async (importOriginal) => {
  const real = await importOriginal<typeof import("@workspace/facade")>()
  return {
    ...real,
    init: () => ({
      dispatch: async (request: {
        message: unknown
        idempotencyKey?: string
      }) => {
        attempts.count++
        const key = request.idempotencyKey
        const message = real.canonical(request.message)
        const first = key ? admitted.get(key) : undefined
        if (first && first.message !== message) {
          throw new real.SubmissionConflictError({
            submissionId: first.submissionId,
          })
        }
        if (first) {
          return { submissionId: first.submissionId, deduplicated: true }
        }
        dispatched.push(request)
        const submissionId = `s-${dispatched.length}`
        if (key) admitted.set(key, { message, submissionId })
        return { submissionId }
      },
    }),
  }
})

const { OwnerApi } = await import("../src/cloudflare.ts")
const { default: consoleApp } = await import("../src/app.ts")
const { requestReview } = await import("../src/publish.ts")
const { advance, cancel } = await import("../src/state.ts")
const { kit, previewed, stateOf } = await import("./site.ts")

/**
 * Owner mode against a real database, through the `OwnerApi` entrypoint the
 * service binding reaches, never through the default export.
 */
const url = process.env.DATABASE_URL
/** Every event sent to a Workflow, and how many sends to fail first. */
const wake = { sent: [] as unknown[], failures: 0 }
beforeEach(() => {
  wake.sent.length = 0
  wake.failures = 0
})
const env = {
  ORCHESTRATOR_TOKEN: "test-token",
  PREVIEW_KEY: "preview-key-for-this-suite-only",
  SITE_HOST_SUFFIX: "-stg.remeai.co.uk",
  HYPERDRIVE: { connectionString: url ?? "postgres://stub" },
  ASSIGNMENTS: {
    create: async ({ id }: { id: string }) => ({ id }),
    get: async () => ({
      sendEvent: async (event: unknown) => {
        if (wake.failures > 0) {
          wake.failures--
          throw new Error("the Workflow did not take the event")
        }
        wake.sent.push(event)
      },
      terminate: async () => undefined,
    }),
  },
  PUBLISHES: { create: async () => ({}) },
} as unknown as Env

const USER = "user_owner_probe"
const SESSION = "session_owner_probe"
const as = (orgId: string) => ({
  [OWNER_BRIDGE_HEADERS.orgId]: orgId,
  [OWNER_BRIDGE_HEADERS.workosUserId]: USER,
  [OWNER_BRIDGE_HEADERS.sessionId]: SESSION,
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
    dispatched.length = 0
    const steered = await owner(orgId, `/${ids.assignmentId}/steer`, {
      message: "Make the header green",
    })
    expect(steered.status).toBe(202)
    const res = await consoleApp.request(
      `/assignments/${ids.assignmentId}/steer?org=${slug}`,
      {
        method: "POST",
        headers: {
          authorization: "Bearer test-token",
          "idempotency-key": crypto.randomUUID(),
        },
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
        payload: {
          message: "Make the header green",
          key_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        taint: ["untrusted_input"],
      },
      {
        payload: {
          message: "Use the brand blue",
          key_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        taint: [],
      },
    ])
    // What reaches the Developer: the owner's words only as a tainted signal.
    expect(dispatched.map((d) => d.message)).toEqual([
      {
        kind: "signal",
        type: "site.change_requested",
        body: "Make the header green",
        attributes: { taint: "untrusted_input" },
      },
      { kind: "user", body: "Use the brand blue" },
    ])
  })

  it("delivers a steer once for its key, and gives a retry the same receipt", async () => {
    const { orgId } = await ownerOrg(kit)
    const ids = await newAssignment(kit, orgId)
    dispatched.length = 0
    const key = crypto.randomUUID()
    const steer = (message: string) =>
      owner(
        orgId,
        `/${ids.assignmentId}/steer`,
        { message },
        {
          "idempotency-key": key,
        }
      )
    const first = await steer("Make the header green")
    expect(first.status).toBe(202)
    const receipt = await first.json()
    // The bridge call timed out after the steer landed, so the api retries.
    const again = await steer("Make the header green")
    expect(again.status).toBe(202)
    expect(await again.json()).toEqual(receipt)
    expect(dispatched).toHaveLength(1)
    // The same key with other words is a different request, and refused.
    const other = await steer("Make the header red")
    expect(other.status).toBe(409)
    expect(await other.json()).toMatchObject({
      class: "validation",
      code: "steer.key_reused",
    })
    expect(dispatched).toHaveLength(1)
    const logged = await kit.withOrg({ orgId }, (db) =>
      db
        .select({ payload: events.payload })
        .from(events)
        .where(
          sql`${events.assignmentId} = ${ids.assignmentId} and ${events.type} = 'assignment.steered'`
        )
    )
    // The key's hash, never the key: the console and activity read payloads.
    expect(logged).toEqual([
      {
        payload: {
          message: "Make the header green",
          key_sha256: createHash("sha256").update(key).digest("hex"),
        },
      },
    ])
  })

  it("refuses a key another caller used, and a key flue holds for another steer", async () => {
    const { orgId, slug } = await ownerOrg(kit)
    const ids = await newAssignment(kit, orgId)
    dispatched.length = 0
    const key = crypto.randomUUID()
    const first = await owner(
      orgId,
      `/${ids.assignmentId}/steer`,
      { message: "Make the header green" },
      { "idempotency-key": key }
    )
    expect(first.status).toBe(202)
    // The console sends the same words under the owner's key: a user turn,
    // not the owner's signal, so it is another steer, refused before flue.
    const tried = attempts.count
    const byConsole = await consoleApp.request(
      `/assignments/${ids.assignmentId}/steer?org=${slug}`,
      {
        method: "POST",
        headers: { authorization: "Bearer test-token", "idempotency-key": key },
        body: JSON.stringify({ message: "Make the header green" }),
      },
      env
    )
    expect(byConsole.status).toBe(409)
    expect(await byConsole.json()).toMatchObject({ code: "steer.key_reused" })
    expect(attempts.count).toBe(tried)
    // flue already admitted this key for other words, with nothing in the
    // log: its conflict is a 409, not a 500.
    const held = crypto.randomUUID()
    admitted.set(held, { message: "other", submissionId: "s-held" })
    const conflicted = await owner(
      orgId,
      `/${ids.assignmentId}/steer`,
      { message: "Make the header green" },
      { "idempotency-key": held }
    )
    expect(conflicted.status).toBe(409)
    expect(await conflicted.json()).toMatchObject({
      class: "validation",
      code: "steer.key_reused",
    })
    expect(dispatched).toHaveLength(1)
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
  /**
   * A build blocked on a question, as the Workflow leaves it: the question
   * asked, then the block that names it. `ask` does it again from
   * `implementing`; `post` answers any question by either path.
   */
  async function asked(field: string, question: Record<string, unknown> = {}) {
    const { orgId, ownerStaffId, slug } = await ownerOrg(kit)
    const ids = await newAssignment(kit, orgId)
    for (const to of ["briefing", "planning", "implementing"] as const) {
      await advance(kit, ids, to)
    }
    const request = async (key: string, extra = {}) => {
      const requestId = crypto.randomUUID()
      await kit.withOrg({ orgId }, (db) =>
        appendEvent(db, {
          orgId,
          assignmentId: ids.assignmentId,
          staffId: null,
          type: "information.requested",
          payload: { ...extra, request_id: requestId, field: key },
        })
      )
      return requestId
    }
    const ask = async (key: string, extra = {}) => {
      const requestId = await request(key, extra)
      await advance(kit, ids, "blocked_on_information", {
        payload: { request_id: requestId },
      })
      return requestId
    }
    const requestId = await ask(field, question)
    const post = (
      by: "owner" | "console",
      request_id: string,
      value: unknown
    ) =>
      by === "owner"
        ? owner(orgId, `/${ids.assignmentId}/answer`, { request_id, value })
        : consoleApp.request(
            `/assignments/${ids.assignmentId}/answer?org=${slug}`,
            {
              method: "POST",
              headers: {
                authorization: "Bearer test-token",
                "idempotency-key": crypto.randomUUID(),
              },
              body: JSON.stringify({ request_id, value }),
            },
            env
          )
    const answer = (value: unknown) => post("owner", requestId, value)
    const byConsole = (value: unknown) => post("console", requestId, value)
    const answered = () =>
      kit.withOrg({ orgId }, async (db) => {
        const rows = await db
          .select({ payload: events.payload })
          .from(events)
          .where(
            sql`${events.assignmentId} = ${ids.assignmentId} and ${events.type} = 'information.answered'`
          )
        return rows.map((row) => row.payload)
      })
    return {
      orgId,
      ownerStaffId,
      ids,
      requestId,
      request,
      ask,
      post,
      answer,
      byConsole,
      answered,
    }
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
    for (const bad of [{ spaces: 2 }, 2, "", "   ", "x".repeat(501), "null"]) {
      expect((await answer(bad)).status).toBe(400)
    }
    // Text that looks like JSON is still the text the owner typed. A question
    // takes one answer, so each text gets its own.
    for (const text of ["Street parking", "[1,2]", "123"]) {
      const next = await asked("business.parking")
      expect((await next.answer(text)).status).toBe(202)
      expect((await current(next.orgId, "business.parking"))?.value).toBe(text)
    }
    expect(await current(orgId, "business.parking")).toBeUndefined()
  })

  // A build that asked twice waits on its second question, the one its latest
  // block names; the owner's `/workspace` shows that one too.
  it.each(["owner", "console"] as const)(
    "answers only the question the build waits on, by the %s",
    async (by) => {
      const b = await asked("business.parking")
      const stale = b.requestId
      await advance(kit, b.ids, "implementing")
      const waiting = await b.ask("business.parking_notes")

      const refused = await b.post(by, stale, "Street parking")
      expect(refused.status).toBe(404)
      expect(await refused.json()).toMatchObject({
        class: "resource",
        code: "request.not_found",
        detail: { request_id: stale },
      })
      expect(await current(b.orgId, "business.parking")).toBeUndefined()

      expect((await b.post(by, waiting, "Street parking")).status).toBe(202)
      expect((await current(b.orgId, "business.parking_notes"))?.value).toBe(
        "Street parking"
      )
    }
  )

  it.each(["owner", "console"] as const)(
    "keeps an answer by the %s whose nudge failed, and nudges again on a retry",
    async (by) => {
      const b = await asked("business.parking")
      // The answer is committed before the nudge, so a failed nudge is
      // logged and the answer stands; the Workflow's next look finds it.
      wake.failures = 1
      const lost = await b.post(by, b.requestId, "Street parking")
      expect(lost.status).toBe(202)
      const [stored] = await b.answered()
      expect(await lost.json()).toEqual(stored)
      expect(wake.sent).toEqual([])

      const retry = await b.post(by, b.requestId, "Street parking")
      expect(retry.status).toBe(202)
      expect(await retry.json()).toEqual(stored)
      expect(wake.sent).toEqual([
        {
          type: "answer",
          payload: {
            request_id: b.requestId,
            fact_id: (stored as { fact_id: string }).fact_id,
          },
        },
      ])

      const other = await b.post(by, b.requestId, "Round the back")
      expect(other.status).toBe(409)
      expect(await other.json()).toMatchObject({
        code: "answer.already_given",
        detail: { request_id: b.requestId },
      })
      expect(await b.answered()).toHaveLength(1)
      expect((await current(b.orgId, "business.parking"))?.value).toBe(
        "Street parking"
      )
    }
  )

  it("refuses a repeat of an answer stored in an older shape rather than failing", async () => {
    const b = await asked("business.parking")
    const fact = await kit.withOrg({ orgId: b.orgId }, (db) =>
      supersedeFact(db, {
        orgId: b.orgId,
        key: "business.parking",
        factType: "business",
        value: "Street parking",
        provenance: { source: "owner_stated", confidence: 1 },
      })
    )
    // No answer_id, answered_at or org: not an `InformationAnswer` today.
    await kit.withOrg({ orgId: b.orgId }, (db) =>
      appendEvent(db, {
        orgId: b.orgId,
        assignmentId: b.ids.assignmentId,
        staffId: null,
        type: "information.answered",
        payload: { request_id: b.requestId, fact_id: fact.factId },
      })
    )
    const res = await b.answer("Street parking")
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "answer.already_given" })
  })

  it("gives a retry for a question the build moved past its receipt, and no nudge", async () => {
    const b = await asked("business.parking")
    const first = await b.answer("Street parking")
    expect(first.status).toBe(202)
    const receipt = await first.json()
    await advance(kit, b.ids, "implementing")
    await b.ask("business.parking_notes")
    wake.sent.length = 0
    const retry = await b.answer("Street parking")
    expect(retry.status).toBe(202)
    expect(await retry.json()).toEqual(receipt)
    expect(wake.sent).toEqual([])
  })

  it("tells a build that is not blocked it is not waiting", async () => {
    const { orgId } = await ownerOrg(kit)
    const ids = await newAssignment(kit, orgId)
    for (const to of ["briefing", "planning", "implementing"] as const) {
      await advance(kit, ids, to)
    }
    const res = await owner(orgId, `/${ids.assignmentId}/answer`, {
      request_id: crypto.randomUUID(),
      value: "Street parking",
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "assignment.not_waiting" })
  })

  it("writes one answer when two arrive at once", async () => {
    const b = await asked("business.parking")
    const both = await Promise.all([
      b.answer("Street parking"),
      b.answer("Street parking"),
    ])
    expect(both.map((res) => res.status)).toEqual([202, 202])
    const [first, second] = await Promise.all(both.map((res) => res.json()))
    expect(second).toEqual(first)
    expect(await b.answered()).toHaveLength(1)
  })

  it("waits only on the question its latest block named, through a pause and resume", async () => {
    const b = await asked("business.parking")
    // Asked after the block and never blocked on, then a pause and a resume,
    // whose move back into the block names no question.
    const skipped = await b.request("business.parking_notes")
    await advance(kit, b.ids, "paused")
    await advance(kit, b.ids, "blocked_on_information")
    const refused = await b.post("owner", skipped, "Street parking")
    expect(refused.status).toBe(404)
    expect(await current(b.orgId, "business.parking_notes")).toBeUndefined()
    expect((await b.answer("Street parking")).status).toBe(202)
  })

  it("holds the console to the same check, reading JSON only where it fits", async () => {
    const { orgId, byConsole } = await asked("business.parking", {
      answer_schema: { type: "string" },
    })
    for (const bad of ["null", "", "   "]) {
      expect((await byConsole(bad)).status).toBe(400)
    }
    expect(await current(orgId, "business.parking")).toBeUndefined()
    expect((await byConsole("123")).status).toBe(202)
    expect((await current(orgId, "business.parking"))?.value).toBe("123")

    const hours = await asked("hours.weekday")
    expect((await hours.byConsole("null")).status).toBe(400)
    expect(
      (await hours.byConsole('{"open":"08:00","close":"18:00"}')).status
    ).toBe(202)
    expect(await current(hours.orgId, "hours.weekday")).toMatchObject({
      value: { open: "08:00", close: "18:00" },
    })
  })

  it("refuses a null answer to a question that offered null", async () => {
    const { orgId, answer } = await asked("hours.saturday", {
      answer_schema: { type: "object", required: ["open", "close"] },
      options: ["null"],
    })
    const res = await answer("null")
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({
      class: "validation",
      code: "answer.invalid",
      detail: { field: "hours.saturday" },
    })
    expect(await current(orgId, "hours.saturday")).toBeUndefined()
  })

  it("holds a text question to its schema and its options", async () => {
    const { orgId, answer } = await asked("business.bookings_email", {
      answer_schema: { type: "string", format: "email" },
      options: ["hello@brightclean.invalid", "book@brightclean.invalid"],
    })
    for (const bad of ["info@brightclean.invalid", "Decline", "null"]) {
      expect((await answer(bad)).status).toBe(400)
    }
    expect(await current(orgId, "business.bookings_email")).toBeUndefined()
    expect((await answer("book@brightclean.invalid")).status).toBe(202)
    expect((await current(orgId, "business.bookings_email"))?.value).toBe(
      "book@brightclean.invalid"
    )
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

  it("answers a failure, not a 202, when the publish cannot start", async () => {
    const built = await previewed()
    await requestReview(kit, built.ids)
    const held = env.PUBLISHES
    const swap = env as unknown as { PUBLISHES: unknown }
    swap.PUBLISHES = {
      create: async () => {
        throw new Error("Workflows is down")
      },
      get: async () => {
        throw new Error("no such instance")
      },
    }
    try {
      const res = await owner(
        built.orgId,
        `/${built.ids.assignmentId}/approve`,
        {
          revision_id: built.revisionId,
        }
      )
      expect(res.status).toBe(503)
    } finally {
      swap.PUBLISHES = held
    }
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

live("an owner deleting their account", () => {
  it("cancels every open build, removes the site's pointer, and answers the same again", async () => {
    const orgId = await freshOrg(kit)
    const open = await newAssignment(kit, orgId)
    const done = await newAssignment(kit, orgId)
    await cancel(kit, done)
    const host = `state-test-${orgId.slice(0, 8)}-stg.remeai.co.uk`
    const elsewhere = "host:someone-else-stg.remeai.co.uk"
    const pointers = new Map([
      [`host:${host}`, "{}"],
      [elsewhere, "{}"],
    ])
    const terminated: string[] = []
    const api = new OwnerApi(
      undefined as never,
      {
        ...env,
        ASSIGNMENTS: {
          get: async (id: string) => ({
            terminate: async () => {
              terminated.push(id)
            },
          }),
        },
        ROUTES: {
          delete: async (key: string) => {
            pointers.delete(key)
          },
        },
      } as unknown as Env
    )
    const takedown = () =>
      api.fetch(
        new Request("https://orchestrator/assignments/site/takedown", {
          method: "POST",
          headers: as(orgId),
        })
      )

    const first = await takedown()
    expect(first.status).toBe(204)
    expect(await stateOf(open)).toBe("cancelled")
    expect(terminated).toEqual([open.assignmentId])
    expect([...pointers.keys()]).toEqual([elsewhere])

    const again = await takedown()
    expect(again.status).toBe(204)
    expect(terminated).toEqual([open.assignmentId])
    expect([...pointers.keys()]).toEqual([elsewhere])
  })
})
