import {
  ActivityFeed,
  ApprovalDecision,
  BuildSummary,
  ErrorEnvelope,
  FactList,
  WorkspaceStatus,
} from "@workspace/contracts"
import { eq, staff, type Tenancy, tenancy } from "@workspace/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { readWorkspace } from "../src/workspace.ts"
import {
  type Owner,
  owner,
  question,
  type Stub,
  SUFFIX,
  seed,
  stubOrchestrator,
} from "./owner-fixture.ts"
import { stubJwksFetch } from "./sealed-session.ts"

/**
 * The owner routes on a live connection, through `worker.fetch` with a real
 * sealed session and a stand-in orchestrator. Cross-org denial is in
 * `tenancy/owner.test.ts`, inside the blocking gate.
 */

const url = process.env.DATABASE_URL

const REQUIRED = [
  "business.name",
  "business.phone",
  "business.email",
  "hours.weekday",
  "service_area.radius",
  "pricing.standard_clean_hourly",
]

const json = (body: unknown, key = crypto.randomUUID()) => ({
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": key },
  body: JSON.stringify(body),
})

/** The orchestrator's refusal at the daily cap. */
const capped = () =>
  Response.json(
    {
      class: "budgetary",
      code: "builds.daily_cap",
      message: "A business starts at most 20 builds in 24 hours.",
      detail: { max: 20 },
      occurred_at: new Date().toISOString(),
    },
    { status: 429 }
  )

/** The `Assignment` the orchestrator's create answers with, for a stub. */
const created = (who: Owner, body: { kind: string; goal: string }) => ({
  assignment_id: crypto.randomUUID(),
  org_id: who.orgId,
  staff_id: who.devId,
  created_by_staff_id: who.chiefId,
  parent_assignment_id: null,
  revision_of_assignment_id: null,
  kind: body.kind,
  state: "queued",
  expected_version: 0,
  goal: body.goal,
  acceptance_criteria: ["probe"],
  fact_snapshot_id: crypto.randomUUID(),
  pack_refs: [],
  budget_usd: 5,
  deadline: null,
  priority: "normal",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
})

describe.skipIf(!url)("the owner routes, on a live connection", () => {
  const kit: Tenancy = tenancy(url as string, { max: 2 })
  let realFetch: typeof fetch
  let fresh: Owner
  let busy: Owner
  let asker: Owner
  let changes: Owner
  let busyIds: Record<string, string>
  let askIds: Record<string, string>

  beforeAll(async () => {
    realFetch = globalThis.fetch
    globalThis.fetch = stubJwksFetch()
    fresh = await owner(kit, url as string, "fresh")
    busy = await owner(kit, url as string, "busy")
    asker = await owner(kit, url as string, "asker")
    changes = await owner(kit, url as string, "changes")

    // The busy org: a live site, a review whose request expired before the
    // hourly sweep parked it, a cancelled build's undecided request, a
    // failure, a build parked on its budget and a publish. The site lock
    // allows one writing build per org, so the question lives in its own.
    const s = seed(kit, busy)
    const live = await s.assignment("published")
    const liveRevision = await s.revision(live, 1)
    await s.deployment(
      liveRevision,
      await s.approval(live, liveRevision, 1, true)
    )
    const published = await s.event(live, "deployment.activated", {
      kind: "publish",
      revision_id: liveRevision,
    })
    const reviewing = await s.assignment("awaiting_review")
    const reviewRevision = await s.revision(reviewing, 2)
    const review = await s.approval(reviewing, reviewRevision, -1)
    const dropped = await s.assignment("cancelled")
    const dangling = await s.approval(dropped, await s.revision(dropped, 3), 48)
    const failed = await s.assignment("failed")
    const failure = await s.event(failed, "assignment.state_changed", {
      from: "validating",
      to: "failed",
    })
    // Two days old: in the activity, out of the panel.
    const old = await s.event(
      failed,
      "assignment.state_changed",
      { from: "repairing", to: "failed" },
      48
    )
    // Past 30 days: in neither.
    await s.event(
      failed,
      "assignment.state_changed",
      { from: "planning", to: "failed" },
      31 * 24
    )
    const parked = await s.assignment("paused")
    const budget = await s.event(parked, "budget.exhausted", {
      cap_usd: 5,
      spent_usd: 5,
    })
    busyIds = {
      liveRevision,
      published,
      reviewing,
      reviewRevision,
      review,
      dangling,
      failure,
      old,
      budget,
      parked,
    }

    const a = seed(kit, asker)
    const asking = await a.assignment("blocked_on_information")
    const askingRevision = await a.revision(asking, 1)
    const request = question(asker, asking)
    await a.event(asking, "information.requested", request)
    const answered = question(asker, asking, "business.email")
    await a.event(asking, "information.requested", answered)
    await a.event(asking, "information.answered", {
      request_id: answered.request_id,
    })
    askIds = {
      asking,
      askingRevision,
      request: request.request_id,
      answered: answered.request_id,
    }
  }, 60_000)

  afterAll(async () => {
    globalThis.fetch = realFetch
    await kit.close()
  })

  const workspace = async (who: Owner, headers: Record<string, string> = {}) =>
    who.call(stubOrchestrator(), "/workspace", { headers })

  it("shows a new org nothing running and the six facts to ask for", async () => {
    const response = await workspace(fresh)
    expect(response.status).toBe(200)
    const body = WorkspaceStatus.parse(await response.json())
    expect(body).toEqual({
      site: { host: null, live: null },
      builds: [],
      attention: [],
      missing_facts: REQUIRED,
    })
  })

  it("derives the review, alerts and report, and the live site", async () => {
    const body = WorkspaceStatus.parse(await (await workspace(busy)).json())
    expect(
      body.attention.map((item) =>
        item.kind === "approval"
          ? item.request.approval_id
          : item.kind === "question"
            ? item.request.request_id
            : item.event_id
      )
    ).toEqual([
      busyIds.review,
      busyIds.budget,
      busyIds.failure,
      busyIds.published,
    ])
    expect(body.attention[0]).toMatchObject({ kind: "approval", version: 2 })
    expect(body.site).toEqual({
      host: `${busy.slug}${SUFFIX}`,
      live: { revision_id: busyIds.liveRevision, version: 1 },
    })
    expect(
      body.builds.map((b) => [b.assignment_id, b.state, b.revision])
    ).toEqual([
      [busyIds.parked, "paused", null],
      [
        busyIds.reviewing,
        "awaiting_review",
        { revision_id: busyIds.reviewRevision, version: 2 },
      ],
    ])
  })

  it("lists an expired, undecided review, since a late decision still counts", async () => {
    const body = WorkspaceStatus.parse(await (await workspace(busy)).json())
    const approvals = body.attention.flatMap((item) =>
      item.kind === "approval" ? [item.request] : []
    )
    expect(approvals.map((a) => a.approval_id)).toEqual([busyIds.review])
    expect(Date.parse(approvals[0]?.expires_at as string)).toBeLessThan(
      Date.now()
    )
  })

  it("leaves out an undecided request whose build has ended", async () => {
    const body = WorkspaceStatus.parse(await (await workspace(busy)).json())
    const ids = body.attention.flatMap((item) =>
      item.kind === "approval" ? [item.request.approval_id] : []
    )
    expect(ids).not.toContain(busyIds.dangling)
  })

  it("lists an open question and not an answered one", async () => {
    const body = WorkspaceStatus.parse(await (await workspace(asker)).json())
    expect(body.attention).toEqual([
      expect.objectContaining({
        kind: "question",
        request: expect.objectContaining({ request_id: askIds.request }),
      }),
    ])
  })

  it("answers an unchanged poll with 304 and no body", async () => {
    const first = await workspace(busy)
    const tag = first.headers.get("etag") as string
    expect(tag).toMatch(/^"[0-9a-f]{32}"$/)
    expect(first.headers.get("cache-control")).toBe("private, no-cache")
    const again = await workspace(busy, { "if-none-match": tag })
    expect(again.status).toBe(304)
    expect(await again.text()).toBe("")
    expect(again.headers.get("etag")).toBe(tag)
  })

  it("answers 200 with a new tag once something changed", async () => {
    const tag = (await workspace(fresh)).headers.get("etag") as string
    const set = await fresh.call(
      stubOrchestrator(),
      "/facts",
      json({ facts: [{ key: "business.name", value: { name: "Probe Co" } }] })
    )
    expect(set.status).toBe(200)
    const after = await workspace(fresh, { "if-none-match": tag })
    expect(after.status).toBe(200)
    expect(after.headers.get("etag")).not.toBe(tag)
    const body = WorkspaceStatus.parse(await after.json())
    expect(body.missing_facts).toEqual(REQUIRED.slice(1))
  })

  it("reads the workspace in one transaction of six statements", async () => {
    let transactions = 0
    let statements = 0
    const counted: Tenancy = {
      ...kit,
      withOrg: (ctx, fn) => {
        transactions += 1
        return kit.withOrg(ctx, (db) =>
          fn(
            new Proxy(db, {
              get(target, prop, receiver) {
                if (prop === "select" || prop === "execute") statements += 1
                return Reflect.get(target, prop, receiver)
              },
            })
          )
        )
      },
    }
    await readWorkspace(counted, busy.orgId, SUFFIX)
    expect(transactions).toBe(1)
    expect(statements).toBe(6)
  })

  it("lists 30 days of reports and alerts as activity, newest first", async () => {
    const response = await busy.call(stubOrchestrator(), "/activity")
    expect(response.status).toBe(200)
    const body = ActivityFeed.parse(await response.json())
    expect(body.items.map((item) => item.event_id)).toEqual([
      busyIds.budget,
      busyIds.failure,
      busyIds.published,
      busyIds.old,
    ])
  })

  describe("facts", () => {
    const facts = async (who: Owner) =>
      FactList.parse(
        await (await who.call(stubOrchestrator(), "/facts")).json()
      ).facts

    it("writes each fact as the owner's, verified by the org's root", async () => {
      const response = await changes.call(
        stubOrchestrator(),
        "/facts",
        json({
          facts: [
            { key: "business.phone", value: { e164: "+15550142" } },
            { key: "hours.weekday", value: { open: "08:00", close: "18:00" } },
          ],
        })
      )
      expect(response.status).toBe(200)
      const [root] = await kit.withOrg({ orgId: changes.orgId }, (db) =>
        db
          .select({ id: staff.id })
          .from(staff)
          .where(eq(staff.staffCode, "OWN-001"))
      )
      const written = await facts(changes)
      expect(written.map((f) => f.key)).toEqual([
        "business.phone",
        "hours.weekday",
      ])
      for (const fact of written) {
        expect(fact.provenance.source).toBe("owner_stated")
        expect(fact.provenance.verified_by_staff_id).toBe(root?.id)
        expect(fact.version).toBe(1)
      }
    })

    it("writes nothing for a value the owner already stated", async () => {
      const body = {
        facts: [
          { key: "hours.weekday", value: { close: "18:00", open: "08:00" } },
        ],
      }
      await changes.call(stubOrchestrator(), "/facts", json(body))
      const hours = (await facts(changes)).find(
        (f) => f.key === "hours.weekday"
      )
      expect(hours?.version).toBe(1)
    })

    it("supersedes a changed value with the next version", async () => {
      await changes.call(
        stubOrchestrator(),
        "/facts",
        json({
          facts: [
            { key: "hours.weekday", value: { open: "09:00", close: "17:00" } },
          ],
        })
      )
      const hours = (await facts(changes)).find(
        (f) => f.key === "hours.weekday"
      )
      expect(hours).toMatchObject({
        version: 2,
        value: { open: "09:00", close: "17:00" },
      })
    })

    it("refuses a repeated key, a bad value and a missing key header", async () => {
      const twice = await changes.call(
        stubOrchestrator(),
        "/facts",
        json({
          facts: [
            { key: "business.name", value: { name: "A" } },
            { key: "business.name", value: { name: "B" } },
          ],
        })
      )
      expect(twice.status).toBe(400)
      expect(ErrorEnvelope.parse(await twice.json()).code).toBe(
        "facts.duplicate_key"
      )
      const bad = await changes.call(
        stubOrchestrator(),
        "/facts",
        json({ facts: [{ key: "business.phone", value: { e164: "0123" } }] })
      )
      expect(ErrorEnvelope.parse(await bad.json()).code).toBe("request.invalid")
      const keyless = await changes.call(stubOrchestrator(), "/facts", {
        method: "POST",
        body: JSON.stringify({ facts: [] }),
      })
      expect(ErrorEnvelope.parse(await keyless.json()).code).toBe(
        "idempotency_key.missing"
      )
    })
  })

  describe("changes", () => {
    const creating = (who: Owner) =>
      stubOrchestrator(async (request) => {
        if (/\/(reject|cancel)$/.test(new URL(request.url).pathname)) {
          return Response.json({}, { status: 201 })
        }
        return Response.json(created(who, await request.clone().json()), {
          status: 201,
        })
      })

    it("builds an unpublished site, keyed by the caller's key", async () => {
      const stub = creating(changes)
      const response = await changes.call(
        stub,
        "/changes",
        json({ text: "Make the hero say we clean ovens." }, "change-build-1")
      )
      expect(response.status).toBe(201)
      expect(BuildSummary.parse(await response.json()).kind).toBe("site.build")
      expect(stub.calls).toHaveLength(1)
      const [call] = stub.calls
      expect(new URL(call?.request.url as string).pathname).toBe(
        "/assignments/"
      )
      expect(call?.request.headers.get("idempotency-key")).toBe(
        "change-build-1"
      )
      expect(call?.body).toEqual({
        kind: "site.build",
        goal: "Make the hero say we clean ovens.",
      })
    })

    it("replays the build a key already made, without the binding", async () => {
      const s = seed(kit, changes)
      const made = await s.assignment("queued", { key: "change-replay-1" })
      const stub = creating(changes)
      const response = await changes.call(
        stub,
        "/changes",
        json({ text: "Anything" }, "change-replay-1")
      )
      expect(response.status).toBe(200)
      expect(BuildSummary.parse(await response.json()).assignment_id).toBe(made)
      expect(stub.calls).toHaveLength(0)
      await s.state(made, "cancelled")
    })

    it("steers a working build", async () => {
      const s = seed(kit, changes)
      const working = await s.assignment("implementing")
      const stub = stubOrchestrator(() =>
        Response.json({ assignment_id: working }, { status: 202 })
      )
      const response = await changes.call(
        stub,
        "/changes",
        json({ text: "Use a darker blue." })
      )
      expect(response.status).toBe(202)
      expect(BuildSummary.parse(await response.json()).assignment_id).toBe(
        working
      )
      expect(new URL(stub.calls[0]?.request.url as string).pathname).toBe(
        `/assignments/${working}/steer`
      )
      expect(stub.calls[0]?.body).toEqual({ message: "Use a darker blue." })
      await s.state(working, "cancelled")
    })

    it("refuses while a question is open, without the binding", async () => {
      const s = seed(kit, changes)
      const asking = await s.assignment("blocked_on_information")
      const stub = creating(changes)
      const response = await changes.call(
        stub,
        "/changes",
        json({ text: "Change the hero." })
      )
      expect(response.status).toBe(409)
      expect(ErrorEnvelope.parse(await response.json()).code).toBe(
        "change.question_open"
      )
      expect(stub.calls).toHaveLength(0)
      await s.state(asking, "cancelled")
    })

    const reviewIn = async (
      state: "awaiting_review" | "blocked_on_approval",
      hours: number,
      version: number
    ) => {
      const s = seed(kit, changes)
      const reviewing = await s.assignment(state)
      const revision = await s.revision(reviewing, version)
      await s.approval(reviewing, revision, hours)
      return { s, reviewing, revision }
    }
    const paths = (stub: Stub) =>
      stub.calls.map((c) => new URL(c.request.url).pathname)

    it("builds first, then turns down the open review", async () => {
      const { s, reviewing, revision } = await reviewIn(
        "awaiting_review",
        72,
        10
      )
      const stub = creating(changes)
      const response = await changes.call(
        stub,
        "/changes",
        json({ text: "Change the hero." })
      )
      expect(response.status).toBe(201)
      expect(paths(stub)).toEqual([
        "/assignments/",
        `/assignments/${reviewing}/reject`,
      ])
      expect(stub.calls[1]?.body).toEqual({ revision_id: revision })
      await s.state(reviewing, "cancelled")
    })

    it("leaves the review open when the build is refused", async () => {
      const { s, reviewing } = await reviewIn("awaiting_review", 72, 11)
      const stub = stubOrchestrator(() => capped())
      const response = await changes.call(
        stub,
        "/changes",
        json({ text: "Change the hero." })
      )
      expect(response.status).toBe(429)
      expect(paths(stub)).toEqual(["/assignments/"])
      await s.state(reviewing, "cancelled")
    })

    it("turns down a review the sweep parked", async () => {
      const { s, reviewing } = await reviewIn("blocked_on_approval", -2, 12)
      const stub = creating(changes)
      await changes.call(stub, "/changes", json({ text: "Change the hero." }))
      expect(paths(stub)).toEqual([
        "/assignments/",
        `/assignments/${reviewing}/reject`,
      ])
      await s.state(reviewing, "cancelled")
    })

    it("cancels a review that expired before the sweep parked it", async () => {
      const { s, reviewing } = await reviewIn("awaiting_review", -1, 13)
      const stub = creating(changes)
      await changes.call(stub, "/changes", json({ text: "Change the hero." }))
      expect(paths(stub)).toEqual([
        "/assignments/",
        `/assignments/${reviewing}/cancel`,
      ])
      await s.state(reviewing, "cancelled")
    })

    it("routes on every unfinished build, not the panel's ten", async () => {
      const s = seed(kit, changes)
      const asking = await s.assignment("blocked_on_information")
      const queued: string[] = []
      for (let i = 0; i < 10; i++) queued.push(await s.assignment("queued"))
      const panel = WorkspaceStatus.parse(
        await (await workspace(changes)).json()
      )
      expect(panel.builds).toHaveLength(10)
      expect(panel.builds.map((b) => b.assignment_id)).not.toContain(asking)
      const stub = creating(changes)
      const response = await changes.call(
        stub,
        "/changes",
        json({ text: "Change the hero." })
      )
      expect(ErrorEnvelope.parse(await response.json()).code).toBe(
        "change.question_open"
      )
      expect(stub.calls).toHaveLength(0)
      for (const id of [asking, ...queued]) await s.state(id, "cancelled")
    })

    it("passes the orchestrator's refusal on as it came", async () => {
      const stub = stubOrchestrator(() => capped())
      const response = await changes.call(
        stub,
        "/changes",
        json({ text: "Change the hero." })
      )
      expect(response.status).toBe(429)
      expect(ErrorEnvelope.parse(await response.json()).code).toBe(
        "builds.daily_cap"
      )
    })

    it("gives an org with no team its team before routing", async () => {
      const bare = await owner(kit, url as string, "bare")
      await kit.withOrg({ orgId: bare.orgId }, async (db) => {
        await db.delete(staff).where(eq(staff.staffCode, "DEV-001"))
        await db.delete(staff).where(eq(staff.staffCode, "COS-001"))
      })
      await bare.call(creating(bare), "/changes", json({ text: "Build it." }))
      const codes = await kit.withOrg({ orgId: bare.orgId }, (db) =>
        db.select({ code: staff.staffCode }).from(staff)
      )
      expect(codes.map((c) => c.code).sort()).toEqual([
        "COS-001",
        "DEV-001",
        "OWN-001",
      ])
    })
  })

  describe("decisions and builds", () => {
    const decision = (id: string, approvalId: string) => ({
      approval_id: approvalId,
      org_id: busy.orgId,
      decision: "approved",
      target: { kind: "revision", revision_id: id },
      decided_by: {
        kind: "owner_session",
        user_id: busy.workosUserId,
        session_id: `session_${busy.workosUserId}`,
      },
      decided_at: new Date().toISOString(),
      workflow_instance_id: approvalId,
    })
    const impersonated = {
      cookie: { impersonator: { email: "admin@probe.invalid", reason: null } },
    }

    it.each([
      ["POST", "/facts", "owner.impersonated"],
      ["POST", "/changes", "owner.impersonated"],
      ["POST", "answer", "owner.impersonated"],
      ["POST", "cancel", "owner.impersonated"],
      ["POST", "decision", "approval.impersonated"],
    ])(
      "refuses an impersonated %s %s before anything else",
      async (_m, route, code) => {
        const path =
          route === "decision"
            ? `/approvals/${busyIds.review}/decision`
            : route.startsWith("/")
              ? route
              : `/builds/${askIds.asking}/${route}`
        const who = route === "decision" ? busy : asker
        const stub = stubOrchestrator()
        const response = await who.call(stub, path, {
          ...json({ text: "x" }),
          ...impersonated,
        })
        expect(response.status).toBe(403)
        expect(ErrorEnvelope.parse(await response.json()).code).toBe(code)
        expect(stub.calls).toHaveLength(0)
      }
    )

    it("lets an impersonated session read", async () => {
      for (const path of ["/workspace", "/facts", "/activity"]) {
        const response = await busy.call(stubOrchestrator(), path, impersonated)
        expect(response.status, path).toBe(200)
      }
    })

    it("approves through the build's route and drops the console's handle", async () => {
      const revision = crypto.randomUUID()
      const stub = stubOrchestrator(() =>
        Response.json(decision(revision, busyIds.review as string), {
          status: 202,
        })
      )
      const response = await busy.call(
        stub,
        `/approvals/${busyIds.review}/decision`,
        json({ decision: "approved", revision_id: revision })
      )
      expect(response.status).toBe(202)
      const body = await response.json()
      expect(body).not.toHaveProperty("workflow_instance_id")
      ApprovalDecision.parse(body)
      const [call] = stub.calls
      expect(new URL(call?.request.url as string).pathname).toBe(
        `/assignments/${busyIds.reviewing}/approve`
      )
      expect(call?.body).toEqual({ revision_id: revision })
    })

    it("rejects through the reject route", async () => {
      const stub = stubOrchestrator()
      await busy.call(
        stub,
        `/approvals/${busyIds.review}/decision`,
        json({ decision: "rejected", revision_id: crypto.randomUUID() })
      )
      expect(stub.calls[0]?.request.url).toMatch(/\/reject$/)
    })

    it("answers 502, not a retry, when a success is off contract", async () => {
      const stub = stubOrchestrator(() =>
        Response.json({ approval_id: "not a decision" }, { status: 202 })
      )
      const response = await busy.call(
        stub,
        `/approvals/${busyIds.review}/decision`,
        json({ decision: "approved", revision_id: crypto.randomUUID() })
      )
      expect(response.status).toBe(502)
      const body = ErrorEnvelope.parse(await response.json())
      expect(body.class).toBe("integrity")
      expect(body.code).toBe("orchestrator.off_contract")
    })

    it("validates an answer before the binding, then relays it", async () => {
      const stub = stubOrchestrator()
      const bad = await asker.call(
        stub,
        `/builds/${askIds.asking}/answer`,
        json({ value: "+15550142" })
      )
      expect(bad.status).toBe(400)
      expect(stub.calls).toHaveLength(0)
      const good = await asker.call(
        stub,
        `/builds/${askIds.asking}/answer`,
        json(
          { request_id: askIds.request, value: { e164: "+15550142" } },
          "answer-1"
        )
      )
      expect(good.status).toBe(409)
      expect(stub.calls[0]?.body).toEqual({
        request_id: askIds.request,
        value: { e164: "+15550142" },
      })
      expect(stub.calls[0]?.request.headers.get("idempotency-key")).toBe(
        "answer-1"
      )
    })

    it("refuses a second answer to a question already answered", async () => {
      const stub = stubOrchestrator()
      const response = await asker.call(
        stub,
        `/builds/${askIds.asking}/answer`,
        json({ request_id: askIds.answered, value: { address: "a@b.invalid" } })
      )
      expect(response.status).toBe(409)
      expect(ErrorEnvelope.parse(await response.json()).code).toBe(
        "answer.already_given"
      )
      expect(stub.calls).toHaveLength(0)
    })

    it("needs an idempotency key to answer or cancel", async () => {
      const stub = stubOrchestrator()
      for (const action of ["answer", "cancel"]) {
        const response = await asker.call(
          stub,
          `/builds/${askIds.asking}/${action}`,
          {
            method: "POST",
            body: JSON.stringify({ request_id: askIds.request, value: "x" }),
          }
        )
        expect(ErrorEnvelope.parse(await response.json()).code, action).toBe(
          "idempotency_key.missing"
        )
      }
      expect(stub.calls).toHaveLength(0)
    })

    it("fetches a preview with GET and cancels with POST", async () => {
      const stub = stubOrchestrator()
      await asker.call(stub, `/builds/${askIds.asking}/preview`)
      await asker.call(stub, `/builds/${askIds.asking}/cancel`, json({}))
      expect(
        stub.calls.map((c) => [
          c.request.method,
          new URL(c.request.url).pathname,
        ])
      ).toEqual([
        ["GET", `/assignments/${askIds.asking}/preview`],
        ["POST", `/assignments/${askIds.asking}/cancel`],
      ])
      const wrong = await asker.call(
        stub,
        `/builds/${askIds.asking}/preview`,
        json({})
      )
      expect(wrong.status).toBe(404)
      expect(stub.calls).toHaveLength(2)
    })

    it("answers a malformed id with 404 and no binding call", async () => {
      const stub = stubOrchestrator()
      const response = await busy.call(
        stub,
        "/builds/not-a-uuid/cancel",
        json({})
      )
      expect(response.status).toBe(404)
      expect(stub.calls).toHaveLength(0)
    })
  })
})
