import {
  ActivityFeed,
  ApprovalDecision,
  BuildSummary,
  ErrorEnvelope,
  FactList,
  InformationAnswer,
  WorkspaceStatus,
} from "@workspace/contracts"
import {
  appendEvent,
  approvals as approvalRows,
  assignments,
  conversationMessages,
  conversations,
  domains,
  eq,
  postAssistantMessage,
  reminders,
  serverMessageId,
  sql,
  staff,
  steerKeyHash,
  supersedeFact,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { startChange } from "../src/changes.ts"
import {
  EXPECTED_SECONDS,
  readQuestions,
  readWorkspace,
} from "../src/workspace.ts"
import {
  type Owner,
  owner,
  question,
  type Stub,
  SUFFIX,
  seed,
  stubOrchestrator,
} from "./owner-fixture.ts"
import { env, stubJwksFetch } from "./sealed-session.ts"

/**
 * The owner routes on a live connection, through `worker.fetch` with a real
 * sealed session and a stand-in orchestrator. Cross-org denial is in
 * `tenancy/owner.test.ts`, inside the blocking gate.
 */

const url = process.env.DATABASE_URL

/** A generated photo's asset id, as the photo step logs it. */
const PHOTO_ID = "0b9c4a1e-2f3d-4c5b-8a6e-7d8f9a0b1c2d"

/** The required facts a new org lacks: sign-up already gave its name. */
const REQUIRED = [
  "business.phone",
  "business.email",
  "business.industry",
  "business.offerings",
  "service_area.text",
]

const json = (body: unknown, key = crypto.randomUUID()) => ({
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": key },
  body: JSON.stringify(body),
})

/**
 * `AbortSignal.timeout`, run at `ms` so a case about a 10 s deadline takes
 * a moment, with every duration it was asked for.
 */
const deadline = (ms: number) => {
  const real = AbortSignal.timeout.bind(AbortSignal)
  const asked: number[] = []
  const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((given) => {
    asked.push(given)
    return real(ms)
  })
  return { asked, restore: () => spy.mockRestore() }
}

/** The orchestrator's refusal to end a review that is no longer open. */
const notRequested = () =>
  Response.json(
    {
      class: "validation",
      code: "approval.not_requested",
      message: "No open approval request on this assignment.",
      detail: {},
      occurred_at: new Date().toISOString(),
    },
    { status: 409 }
  )

const never = () => new Promise<Response>(() => undefined)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

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
    // Parked by the sweep after its request expired: still decidable.
    const reviewing = await s.assignment("blocked_on_approval")
    const reviewRevision = await s.revision(reviewing, 2)
    const review = await s.approval(reviewing, reviewRevision, -1)
    // The photos this build placed: only the generated one is badged.
    await s.event(reviewing, "site.photos", {
      slots: [
        {
          id: "hero_room",
          section: "hero",
          alt: "A sunlit room",
          source: "generated",
          asset_id: PHOTO_ID,
        },
        {
          id: "owner_team",
          section: "about",
          alt: "Our team",
          source: "upload",
        },
      ],
      brief: { industry: "cleaning", imageStyle: "airy", palette: "sage" },
      regenerated: null,
    })
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
    // Refused by the gates before the budget ran out: no number, so no ref.
    await s.revision(parked, null)
    const budget = await s.event(parked, "budget.exhausted", {
      cap_usd: 5,
      spent_usd: 5,
    })
    busyIds = {
      live,
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
    await a.blocked(asking, request.request_id, 4)
    const fact = await kit.withOrg({ orgId: asker.orgId }, (db) =>
      supersedeFact(db, {
        orgId: asker.orgId,
        key: "business.email",
        factType: "contact",
        value: { address: "owner@asker.invalid" },
        provenance: { source: "owner_stated", confidence: 1 },
      })
    )
    await a.event(asking, "information.answered", {
      answer_id: crypto.randomUUID(),
      org_id: asker.orgId,
      assignment_id: asking,
      request_id: answered.request_id,
      fact_id: fact.factId,
      answered_at: new Date().toISOString(),
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

  it("shows a new org nothing running and the five facts to ask for", async () => {
    const response = await workspace(fresh)
    expect(response.status).toBe(200)
    const body = WorkspaceStatus.parse(await response.json())
    expect(body).toEqual({
      site: { host: null, url: null, live: null },
      builds: [],
      attention: [],
      missing_facts: REQUIRED,
      assistant_name: null,
      expected_seconds: EXPECTED_SECONDS,
      reminders: {
        notes: [],
        derived: [{ rule: "facts_missing", keys: REQUIRED }],
      },
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
            : item.kind === "reminder"
              ? item.reminder_id
              : item.event_id
      )
    ).toEqual([
      busyIds.review,
      busyIds.budget,
      busyIds.failure,
      busyIds.published,
    ])
    expect(body.attention[0]).toMatchObject({
      kind: "approval",
      version: 2,
      photos: [
        {
          slot_id: "hero_room",
          section: "hero",
          alt: "A sunlit room",
          thumbnail: `/api/photos/${PHOTO_ID}`,
        },
      ],
    })
    expect(body.site).toEqual({
      host: `${busy.slug}${SUFFIX}`,
      url: `https://${busy.slug}${SUFFIX}`,
      live: {
        revision_id: busyIds.liveRevision,
        version: 1,
        assignment_id: busyIds.live,
      },
    })
    // Local dev's config links the same site to the local router instead.
    const local = await readWorkspace(kit, busy.orgId, {
      SITE_HOST_SUFFIX: ".reme.localhost" as Env["SITE_HOST_SUFFIX"],
      SITE_PORT: "3004",
    })
    expect(local.site.url).toBe(`http://${busy.slug}.reme.localhost:3004`)
    expect(
      body.builds.map((b) => [b.assignment_id, b.state, b.revision])
    ).toEqual([
      [busyIds.parked, "paused", null],
      [
        busyIds.reviewing,
        "blocked_on_approval",
        { revision_id: busyIds.reviewRevision, version: 2 },
      ],
    ])
  })

  it("names the active custom domain over https, and the slug host while the domain only connects", async () => {
    const name = `${crypto.randomUUID().slice(0, 8)}.example`
    const row = (state: "awaiting_dns" | "active") =>
      kit.withOrg({ orgId: busy.orgId }, (db) =>
        db
          .insert(domains)
          .values({
            orgId: busy.orgId,
            siteId: busy.orgId,
            name,
            primaryHost: `www.${name}`,
            origin: "connected",
            method: "records",
            state,
          })
          .returning({ id: domains.id })
      )
    const local = {
      SITE_HOST_SUFFIX: ".reme.localhost" as Env["SITE_HOST_SUFFIX"],
      SITE_PORT: "3004",
    }
    const [connecting] = await row("awaiting_dns")
    try {
      expect((await readWorkspace(kit, busy.orgId, local)).site).toMatchObject({
        host: `${busy.slug}.reme.localhost`,
        url: `http://${busy.slug}.reme.localhost:3004`,
      })
      await kit.withOrg({ orgId: busy.orgId }, (db) =>
        db
          .update(domains)
          .set({ state: "active" })
          .where(eq(domains.id, connecting?.id as string))
      )
      // No port and no http, even on local dev: the domain is Cloudflare's.
      expect((await readWorkspace(kit, busy.orgId, local)).site).toMatchObject({
        host: `www.${name}`,
        url: `https://www.${name}`,
      })
    } finally {
      await kit.withOrg({ orgId: busy.orgId }, (db) =>
        db.delete(domains).where(eq(domains.name, name))
      )
    }
  })

  it("shows a working build's photos as they settle and its pages by name, its clock without the plan review", async () => {
    const who = await owner(kit, url as string, "live-build")
    const s = seed(kit, who)
    const build = await s.assignment("implementing")
    const page = (id: string) => ({
      page: id,
      sections: [
        { kind: "hero", variant: "wash", purpose: "Lead", content_notes: null },
      ],
    })
    const slot = (id: string) => ({
      id,
      page: "home",
      section: "hero",
      aspect: "16:9",
      resolution: "1K",
      subject: "A clean kitchen",
      alt: `Photo ${id}`,
      source: "generated",
    })
    await kit.withOrg({ orgId: who.orgId }, (db) =>
      db
        .update(assignments)
        .set({
          blueprint: {
            direction: "calm_daylight",
            fonts: "outfit_figtree",
            palette: { kind: "preset", id: "forest" },
            pages: [page("home"), page("services")],
            images: [slot("hero"), slot("team")],
            voice: "Warm and plain.",
            features: ["One", "Two", "Three", "Four"],
          },
        })
        .where(eq(assignments.id, build))
    )
    // Proposed for review 30 minutes ago and decided 15 minutes later.
    await s.event(build, "blueprint.proposed", { round: 1, review: true }, 0.5)
    await s.event(build, "blueprint.decided", { round: 1 }, 0.25)
    const progress = (payload: Record<string, unknown>) =>
      s.event(build, "build.progress", payload)
    await progress({ stage: "photos", item: null, total: 2 })
    await progress({
      stage: "photos",
      item: "team",
      total: 2,
      status: "generated",
      asset_id: PHOTO_ID,
    })
    await progress({ stage: "pages", item: null, total: 2 })
    await progress({ stage: "pages", item: "services", total: 2 })

    const body = WorkspaceStatus.parse(await (await workspace(who)).json())
    const [shown] = body.builds
    expect(shown?.photos).toEqual([
      {
        slot_id: "team",
        state: "made",
        alt: "Photo team",
        thumbnail: `/api/photos/${PHOTO_ID}`,
      },
      { slot_id: "hero", state: "drawing", alt: "Photo hero", thumbnail: null },
    ])
    expect(shown?.activity?.find((r) => r.id === "writing")).toMatchObject({
      done: 1,
      total: 2,
      items: [
        { label: "Home", done: false },
        { label: "Services", done: true },
      ],
    })
    // 15 minutes, give or take the insert's clock.
    expect(Math.round((shown?.review_ms ?? 0) / 60_000)).toBe(15)

    // The lead reports, though no page builder said so: the pages tick, and
    // the design look is the step it is on until it answers.
    const stepsNow = async () => {
      const now = WorkspaceStatus.parse(await (await workspace(who)).json())
      const rows = now.builds[0]?.activity ?? []
      return { rows, at: rows.find((r) => r.done < r.total)?.id }
    }
    await s.event(build, "assignment.completion_reported", { risks: [] })
    const looking = await stepsNow()
    expect(looking.at).toBe("design")
    expect(
      looking.rows.find((r) => r.id === "writing")?.items?.map((i) => i.done)
    ).toEqual([true, true])
    // It asks for a change: the lead polishes until it reports again, then the checks.
    await s.event(build, "design.critiqued", {
      ran: true,
      fixes: [{ page: "home", section: "hero" }],
    })
    expect((await stepsNow()).at).toBe("polishing")
    await s.event(build, "assignment.completion_reported", { risks: [] })
    expect((await stepsNow()).at).toBe("checking")

    // The gates send it back: a repair of its own, until the lead reports again.
    await s.event(build, "assignment.state_changed", {
      from: "validating",
      to: "repairing",
    })
    const fixing = await stepsNow()
    expect(fixing.at).toBe("fixing")
    expect(fixing.rows.map((r) => r.id)).toEqual([
      "planning",
      "photos",
      "writing",
      "assembling",
      "design",
      "polishing",
      "fixing",
      "checking",
    ])
    await s.event(build, "assignment.completion_reported", { risks: [] })
    expect((await stepsNow()).at).toBe("checking")

    // The clock stops where the build got ready, and a later move does not
    // shift it.
    const readyAt = async () => {
      const [first] = WorkspaceStatus.parse(
        await (await workspace(who)).json()
      ).builds
      return first?.ready_at
    }
    expect(await readyAt()).toBeUndefined()
    await s.event(build, "assignment.state_changed", {
      from: "validating",
      to: "preview_ready",
    })
    const ready = await readyAt()
    expect(ready).toBeDefined()
    await s.event(build, "assignment.state_changed", {
      from: "preview_ready",
      to: "release_candidate",
    })
    expect(await readyAt()).toBe(ready)
  })

  it("lists an expired review the sweep parked, since a late decision counts", async () => {
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

  it("shows one question per build, the one it last blocked on", async () => {
    const twice = await owner(kit, url as string, "twice")
    const t = seed(kit, twice)
    const build = await t.assignment("blocked_on_information")
    const first = question(twice, build)
    const second = question(twice, build)
    for (const [asked, version] of [
      [first, 3],
      [second, 5],
    ] as const) {
      await t.event(build, "information.requested", asked)
      await t.blocked(build, asked.request_id, version)
    }
    const body = WorkspaceStatus.parse(await (await workspace(twice)).json())
    expect(body.attention).toEqual([{ kind: "question", request: second }])
  })

  it("still shows the question after a pause and resume, whose block names none", async () => {
    const resumed = await owner(kit, url as string, "resumed")
    const r = seed(kit, resumed)
    const build = await r.assignment("blocked_on_information")
    const asked = question(resumed, build)
    await r.event(build, "information.requested", asked)
    await r.blocked(build, asked.request_id, 3)
    // Asked later and never blocked on: not the question the build waits on.
    await r.event(
      build,
      "information.requested",
      question(resumed, build, "business.email")
    )
    await r.transition(build, "blocked_on_information", "paused", 4)
    await r.transition(build, "paused", "blocked_on_information", 5)
    const body = WorkspaceStatus.parse(await (await workspace(resumed)).json())
    expect(body.attention).toEqual([{ kind: "question", request: asked }])
  })

  it("says why a build failed: its transition's reason, in the owner's terms", async () => {
    const stopped = await owner(kit, url as string, "stopped")
    const t = seed(kit, stopped)
    const quiet = await t.assignment("implementing")
    await t.transition(
      quiet,
      "implementing",
      "failed",
      4,
      {},
      "developer.stalled"
    )
    const gaveUp = await t.assignment("implementing")
    await t.transition(
      gaveUp,
      "implementing",
      "failed",
      4,
      {},
      "developer.no_report"
    )
    const odd = await t.assignment("implementing")
    await t.transition(odd, "implementing", "failed", 4, {}, "something.new")
    const body = WorkspaceStatus.parse(await (await workspace(stopped)).json())
    const causes = Object.fromEntries(
      body.attention.flatMap((item) =>
        item.kind === "alert" ? [[item.assignment_id, item.cause]] : []
      )
    )
    expect(causes).toEqual({
      [quiet]: "stalled",
      [gaveUp]: "unfinished",
      [odd]: "other",
    })
    // A failed build is not one being worked on: no step, no Stop.
    expect(body.builds).toEqual([])
  })

  it("drops the question once it is answered, while the build still waits", async () => {
    const waiting = await owner(kit, url as string, "answered")
    const w = seed(kit, waiting)
    const build = await w.assignment("blocked_on_information")
    const asked = question(waiting, build)
    await w.event(build, "information.requested", asked)
    await w.blocked(build, asked.request_id, 3)
    const before = WorkspaceStatus.parse(
      await (await workspace(waiting)).json()
    )
    expect(before.attention).toEqual([{ kind: "question", request: asked }])
    // The Workflow has not woken yet, so the state is still the blocked one.
    await w.event(build, "information.answered", {
      answer_id: crypto.randomUUID(),
      org_id: waiting.orgId,
      assignment_id: build,
      request_id: asked.request_id,
      fact_id: crypto.randomUUID(),
      answered_at: new Date().toISOString(),
    })
    const after = WorkspaceStatus.parse(await (await workspace(waiting)).json())
    expect(after.attention).toEqual([])
  })

  it("answers an unchanged poll with 304 and no body", async () => {
    const first = await workspace(busy)
    const tag = first.headers.get("etag") as string
    // The body's hash, then the chat's newest message: onboarding's opening.
    expect(tag).toMatch(/^"[0-9a-f]{32}\.[A-Za-z0-9_-]{1,64}"$/)
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
      json({ facts: [{ key: "business.phone", value: { e164: "+15550143" } }] })
    )
    expect(set.status).toBe(200)
    const after = await workspace(fresh, { "if-none-match": tag })
    expect(after.status).toBe(200)
    expect(after.headers.get("etag")).not.toBe(tag)
    const body = WorkspaceStatus.parse(await after.json())
    expect(body.missing_facts).toEqual(REQUIRED.slice(1))
  })

  it("changes the tag when the assistant posts in the chat, the body unchanged", async () => {
    const poster = await owner(kit, url as string, "poster")
    const id = crypto.randomUUID()
    await kit.withOrg({ orgId: poster.orgId }, async (db) => {
      await db.insert(conversations).values({
        id,
        orgId: poster.orgId,
        kind: "assistant",
        createdByStaffId: poster.chiefId,
      })
      await db.insert(conversationMessages).values({
        conversationId: id,
        id: "said_1",
        orgId: poster.orgId,
        format: "ai-sdk/v6",
        content: {
          role: "assistant",
          parts: [{ type: "text", text: "Hi", state: "done" }],
        },
      })
    })
    const first = await workspace(poster)
    const tag = first.headers.get("etag") as string
    expect(tag).toMatch(/^"[0-9a-f]{32}\.said_1"$/)
    const posted = await postAssistantMessage(kit, {
      orgId: poster.orgId,
      key: "live:poster",
      message: { text: ["Your website is live."] },
    })
    expect(posted).toBe("posted")
    const after = await workspace(poster, { "if-none-match": tag })
    expect(after.status).toBe(200)
    expect(after.headers.get("etag")).toBe(
      tag.replace("said_1", serverMessageId("live:poster"))
    )
  })

  it("names the assistant once the owner chose a name", async () => {
    const set = await fresh.call(
      stubOrchestrator(),
      "/facts",
      json({ facts: [{ key: "assistant.name", value: { name: "Ava" } }] })
    )
    expect(set.status).toBe(200)
    const body = WorkspaceStatus.parse(await (await workspace(fresh)).json())
    expect(body.assistant_name).toBe("Ava")
  })

  it("changes the tag when a reminder comes due, with no row changed", async () => {
    const due = await owner(kit, url as string, "due")
    const d = seed(kit, due)
    const build = await d.assignment("awaiting_review")
    const approval = await d.approval(build, await d.revision(build, 1), 25)
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() })
    try {
      const first = await workspace(due)
      const tag = first.headers.get("etag") as string
      const before = WorkspaceStatus.parse(await first.json())
      expect(before.reminders.derived.map((r) => r.rule)).toEqual([
        "facts_missing",
      ])
      vi.setSystemTime(Date.now() + 2 * 3_600_000)
      const later = await workspace(due, { "if-none-match": tag })
      expect(later.status).toBe(200)
      expect(later.headers.get("etag")).not.toBe(tag)
      const body = WorkspaceStatus.parse(await later.json())
      expect(body.reminders.derived[0]).toMatchObject({
        rule: "approval_expiring",
        approval_id: approval,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  describe("derived reminders", () => {
    const derived = async (who: Owner, now?: Date) =>
      (await readWorkspace(kit, who.orgId, { SITE_HOST_SUFFIX: SUFFIX }, now))
        .reminders.derived

    it("reminds of a review under 24 hours from expiry until it is decided", async () => {
      const who = await owner(kit, url as string, "expiring")
      const s = seed(kit, who)
      const build = await s.assignment("awaiting_review")
      const approval = await s.approval(build, await s.revision(build, 1), 10)
      const [first, ...rest] = await derived(who)
      expect(first).toMatchObject({
        rule: "approval_expiring",
        approval_id: approval,
        version: 1,
      })
      expect(rest).toEqual([{ rule: "facts_missing", keys: REQUIRED }])
      await kit.withOrg({ orgId: who.orgId }, (db) =>
        db
          .update(approvalRows)
          .set({
            decision: "approved",
            decidedBy: { kind: "console" },
            decidedAt: new Date(),
          })
          .where(eq(approvalRows.id, approval))
      )
      expect(await derived(who)).toEqual(rest)
    })

    it("reminds of a question open over 12 hours until it is answered", async () => {
      const who = await owner(kit, url as string, "waiting")
      const s = seed(kit, who)
      const build = await s.assignment("blocked_on_information")
      const asked = {
        ...question(who, build),
        requested_at: new Date(Date.now() - 13 * 3_600_000).toISOString(),
      }
      await s.event(build, "information.requested", asked, 13)
      await s.blocked(build, asked.request_id, 3)
      expect((await derived(who))[0]).toEqual({
        rule: "question_waiting",
        request_id: asked.request_id,
      })
      await s.event(build, "information.answered", {
        answer_id: crypto.randomUUID(),
        org_id: who.orgId,
        assignment_id: build,
        request_id: asked.request_id,
        fact_id: crypto.randomUUID(),
        answered_at: new Date().toISOString(),
      })
      expect((await derived(who)).map((r) => r.rule)).toEqual(["facts_missing"])
    })

    it("reminds of an unreviewed preview until it is published or cancelled", async () => {
      const who = await owner(kit, url as string, "previewed")
      const s = seed(kit, who)
      for (const [version, end] of [
        [1, "published"],
        [2, "cancelled"],
      ] as const) {
        const build = await s.assignment("preview_ready")
        await s.revision(build, version)
        expect((await derived(who)).map((r) => r.rule)).toEqual([
          "facts_missing",
        ])
        const later = new Date(Date.now() + 13 * 3_600_000)
        expect((await derived(who, later))[0]).toEqual({
          rule: "preview_unpublished",
          assignment_id: build,
          version,
        })
        await s.state(build, end)
        expect((await derived(who, later)).map((r) => r.rule)).toEqual([
          "facts_missing",
        ])
      }
    })
  })

  it("reads the workspace in one transaction of ten statements", async () => {
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
    await readWorkspace(counted, busy.orgId, { SITE_HOST_SUFFIX: SUFFIX })
    expect(transactions).toBe(1)
    // The tenth reads the generated photos of the waiting approval; the
    // reminders that came due and the paused jobs are one each.
    expect(statements).toBe(10)
  })

  it("lists a reminder once it is due and until it is done, after the questions and before the alerts", async () => {
    const who = await owner(kit, url as string, "due-reminders")
    const d = seed(kit, who)
    const build = await d.assignment("awaiting_review")
    const approval = await d.approval(build, await d.revision(build, 1), 25)
    const made = await kit.withOrg({ orgId: who.orgId }, async (db) => {
      const row = (title: string, dueAt: Date | null, doneAt?: Date) => ({
        orgId: who.orgId,
        title,
        dueAt,
        doneAt: doneAt ?? null,
        source: "owner" as const,
        createdByStaffId: who.chiefId,
      })
      const rows = await db
        .insert(reminders)
        .values([
          row("due earlier", new Date(Date.now() - 3 * 3_600_000)),
          row("due later", new Date(Date.now() - 3_600_000)),
          row("not yet", new Date(Date.now() + 3_600_000)),
          row("done", new Date(Date.now() - 3_600_000), new Date()),
          row("undated", null),
        ])
        .returning({ id: reminders.id, title: reminders.title })
      return Object.fromEntries(rows.map((r) => [r.title, r.id]))
    })
    const body = WorkspaceStatus.parse(await (await workspace(who)).json())
    expect(body.attention).toMatchObject([
      { kind: "approval", request: { approval_id: approval } },
      { kind: "reminder", reminder_id: made["due later"], title: "due later" },
      {
        kind: "reminder",
        reminder_id: made["due earlier"],
        title: "due earlier",
      },
    ])
  })

  it("lists a paused job as an alert in the activity feed and the panel, though it belongs to no build", async () => {
    const who = await owner(kit, url as string, "paused-job")
    const eventId = await kit.withOrg({ orgId: who.orgId }, (db) =>
      appendEvent(db, {
        orgId: who.orgId,
        assignmentId: null,
        staffId: null,
        type: "alert.raised",
        payload: { kind: "job.paused", job_id: crypto.randomUUID() },
      })
    )
    const feed = ActivityFeed.parse(
      await (await who.call(stubOrchestrator(), "/activity")).json()
    )
    expect(feed.items).toMatchObject([
      {
        kind: "alert",
        event_id: eventId,
        assignment_id: null,
        reason: "job_paused",
      },
    ])
    const panel = WorkspaceStatus.parse(await (await workspace(who)).json())
    expect(panel.attention).toMatchObject([
      { kind: "alert", event_id: eventId, reason: "job_paused" },
    ])
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
      // The name is sign-up's, stated the same way.
      expect(written.map((f) => f.key)).toEqual([
        "business.name",
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
    // Every case here builds on an org with nothing unfinished, so a case
    // that fails before its own clean-up must not leave a build behind for
    // the next one to route around.
    afterEach(() =>
      kit.withOrg({ orgId: changes.orgId }, (db) =>
        db
          .update(assignments)
          .set({ state: "cancelled", updatedAt: new Date() })
          .where(
            sql`${assignments.state} not in ('published', 'failed', 'cancelled')`
          )
      )
    )

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
        json(
          { text: "Make the hero say we clean ovens.", change_kind: "copy" },
          "change-build-1"
        )
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
        change_kind: "copy",
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
        json({ text: "Use a darker blue.", change_kind: "style" })
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

    it("replays a steer its key made against that build, never routing again", async () => {
      const s = seed(kit, changes)
      const steered = await s.assignment("implementing")
      const key = "change-steer-replay-1"
      // The first attempt's steer landed (the orchestrator logged it under the
      // key's hash), then the bridge timed out, and the build moved on: routed
      // afresh, this change would now start a second build.
      await s.event(steered, "assignment.steered", {
        message: "Use a darker blue.",
        key_sha256: steerKeyHash(key),
      })
      await s.state(steered, "failed")
      const stub = stubOrchestrator(() =>
        Response.json(
          { assignment_id: steered, submission_id: "s-1" },
          { status: 202 }
        )
      )
      const response = await changes.call(
        stub,
        "/changes",
        json({ text: "Use a darker blue." }, key)
      )
      expect(response.status).toBe(202)
      expect(BuildSummary.parse(await response.json()).assignment_id).toBe(
        steered
      )
      expect(paths(stub)).toEqual([`/assignments/${steered}/steer`])
      expect(stub.calls[0]?.body).toEqual({ message: "Use a darker blue." })
      expect(stub.calls[0]?.request.headers.get("idempotency-key")).toBe(key)
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

    it("hides a review that expired before the sweep, and waits it out", async () => {
      const { s, reviewing } = await reviewIn("awaiting_review", -1, 13)
      const panel = WorkspaceStatus.parse(
        await (await workspace(changes)).json()
      )
      expect(panel.attention.filter((i) => i.kind === "approval")).toEqual([])
      const stub = creating(changes)
      const response = await changes.call(
        stub,
        "/changes",
        json({ text: "Change the hero." })
      )
      expect(response.status).toBe(409)
      expect(ErrorEnvelope.parse(await response.json()).code).toBe(
        "change.build_busy"
      )
      expect(stub.calls).toHaveLength(0)
      await s.state(reviewing, "cancelled")
    })

    it("cancels the new build only when the old review is refused", async () => {
      for (const [n, [refusal, status, code, cancels]] of (
        [
          [notRequested, 409, "approval.not_requested", true],
          // Unknown, not refused: the review may have ended, so the new
          // build stays.
          [
            () => new Response("upstream broke", { status: 500 }),
            503,
            "orchestrator.unavailable",
            false,
          ],
          [
            () =>
              Response.json(
                {
                  class: "provider",
                  code: "sandbox.down",
                  message: "The sandbox is down.",
                  detail: {},
                  occurred_at: new Date().toISOString(),
                },
                { status: 502 }
              ),
            503,
            "sandbox.down",
            false,
          ],
        ] as const
      ).entries()) {
        const { s, reviewing } = await reviewIn("awaiting_review", 72, 14 + n)
        let made = ""
        const stub = stubOrchestrator(async (request) => {
          const path = new URL(request.url).pathname
          if (path === "/assignments/") {
            const body = created(changes, await request.clone().json())
            made = body.assignment_id
            return Response.json(body, { status: 201 })
          }
          if (path.endsWith("/reject")) return refusal()
          return Response.json({ assignment_id: made, state: "cancelled" })
        })
        const response = await changes.call(
          stub,
          "/changes",
          json({ text: "Change the hero." })
        )
        expect(response.status).toBe(status)
        const answered = ErrorEnvelope.parse(await response.json())
        expect(answered.code).toBe(code)
        expect(answered.class).toBe(cancels ? "validation" : "transient")
        expect(paths(stub)).toEqual([
          "/assignments/",
          `/assignments/${reviewing}/reject`,
          ...(cancels ? [`/assignments/${made}/cancel`] : []),
        ])
        await s.state(reviewing, "cancelled")
      }
    })

    /**
     * A stand-in that writes what the orchestrator would: the create makes
     * the queued build under the caller's key, a reject that answers ends
     * the review, a cancel cancels the new build. `hang` answers never,
     * after the write for the create and the cancel and before it for the
     * reject; `delay` slows every call.
     */
    const replacing = (
      s: ReturnType<typeof seed>,
      reviewing: string,
      plan: {
        create?: "hang"
        end?: "hang" | "refuse"
        cancel?: "hang" | "refuse"
        delay?: number
      } = {}
    ) => {
      const made: { id: string } = { id: "" }
      const stub = stubOrchestrator(async (request) => {
        if (plan.delay) await sleep(plan.delay)
        const path = new URL(request.url).pathname
        if (path === "/assignments/") {
          const key = request.headers.get("idempotency-key") ?? ""
          made.id = await s.assignment("queued", { key })
          if (plan.create === "hang") return never()
          const body = created(changes, await request.clone().json())
          return Response.json(
            { ...body, assignment_id: made.id },
            { status: 201 }
          )
        }
        if (path === `/assignments/${reviewing}/reject`) {
          if (plan.end === "hang") return never()
          if (plan.end === "refuse") return notRequested()
          await s.state(reviewing, "cancelled")
          return Response.json({})
        }
        if (plan.cancel === "refuse") return notRequested()
        await s.state(made.id, "cancelled")
        if (plan.cancel === "hang") return never()
        return Response.json({ assignment_id: made.id, state: "cancelled" })
      })
      return { stub, made }
    }
    const stateOf = async (id: string) => {
      const [row] = await kit.withOrg({ orgId: changes.orgId }, (db) =>
        db
          .select({ state: assignments.state })
          .from(assignments)
          .where(eq(assignments.id, id))
      )
      return row?.state
    }

    it.each([
      ["the create", { create: "hang" }, ["/assignments/"], 20],
      ["ending the review", { end: "hang" }, ["/assignments/", "reject"], 21],
    ] as const)(
      "makes no further call when %s times out, and the retry ends the review under the same build",
      async (_step, plan, called, version) => {
        const { s, reviewing } = await reviewIn("awaiting_review", 72, version)
        const key = crypto.randomUUID()
        const first = replacing(s, reviewing, plan)
        const timer = deadline(1_000)
        try {
          const response = await changes.call(
            first.stub,
            "/changes",
            json({ text: "Change the hero." }, key)
          )
          expect(response.status).toBe(503)
          expect(ErrorEnvelope.parse(await response.json())).toMatchObject({
            class: "transient",
            code: "orchestrator.timeout",
          })
        } finally {
          timer.restore()
        }
        expect(paths(first.stub)).toEqual(
          called.map((p) =>
            p === "reject" ? `/assignments/${reviewing}/reject` : p
          )
        )
        expect(await stateOf(first.made.id)).toBe("queued")
        const retry = replacing(s, reviewing)
        const again = await changes.call(
          retry.stub,
          "/changes",
          json({ text: "Change the hero." }, key)
        )
        expect(again.status).toBe(200)
        expect(BuildSummary.parse(await again.json()).assignment_id).toBe(
          first.made.id
        )
        expect(paths(retry.stub)).toEqual([`/assignments/${reviewing}/reject`])
        expect(await stateOf(reviewing)).toBe("cancelled")
        await s.state(first.made.id, "cancelled")
      },
      15_000
    )

    it("answers 503 when the cancel after a refusal times out, and the retry 409", async () => {
      const { s, reviewing } = await reviewIn("awaiting_review", 72, 22)
      const key = crypto.randomUUID()
      const first = replacing(s, reviewing, { end: "refuse", cancel: "hang" })
      const timer = deadline(1_000)
      try {
        const response = await changes.call(
          first.stub,
          "/changes",
          json({ text: "Change the hero." }, key)
        )
        expect(response.status).toBe(503)
      } finally {
        timer.restore()
      }
      expect(paths(first.stub)).toEqual([
        "/assignments/",
        `/assignments/${reviewing}/reject`,
        `/assignments/${first.made.id}/cancel`,
      ])
      const retry = replacing(s, reviewing)
      const again = await changes.call(
        retry.stub,
        "/changes",
        json({ text: "Change the hero." }, key)
      )
      expect(again.status).toBe(409)
      expect(ErrorEnvelope.parse(await again.json())).toMatchObject({
        class: "validation",
        code: "change.cancelled",
        detail: { assignment_id: first.made.id },
      })
      expect(retry.stub.calls).toHaveLength(0)
      await s.state(reviewing, "cancelled")
    }, 15_000)

    it("ends three slow calls at one 10 s deadline, not one each", async () => {
      const { s, reviewing } = await reviewIn("awaiting_review", 72, 23)
      // Each call takes 400 ms against a deadline of 1 s: a clock per call
      // would let all three finish and answer the refusal.
      const { stub, made } = replacing(s, reviewing, {
        end: "refuse",
        delay: 400,
      })
      const timer = deadline(1_000)
      try {
        const response = await changes.call(
          stub,
          "/changes",
          json({ text: "Change the hero." })
        )
        // One 10 s deadline for the change (the driver asks for others).
        expect(timer.asked.filter((ms) => ms === 10_000)).toHaveLength(1)
        expect(response.status).toBe(503)
        expect(ErrorEnvelope.parse(await response.json()).code).toBe(
          "orchestrator.timeout"
        )
      } finally {
        timer.restore()
      }
      await s.state(reviewing, "cancelled")
      if (made.id) await s.state(made.id, "cancelled")
    })

    it("gives up on its own reads at the deadline", async () => {
      // The read the deadline gave up on still runs; awaited below so it
      // ends inside this case.
      let late: Promise<unknown> = Promise.resolve()
      const slow: Tenancy = {
        ...kit,
        withOrg: (ctx, fn) => {
          const run = sleep(1_000).then(() => kit.withOrg(ctx, fn))
          late = run.catch(() => undefined)
          return run
        },
      }
      const stub = stubOrchestrator()
      const timer = deadline(200)
      const started = Date.now()
      try {
        const response = await startChange(
          {
            ...env(url as string),
            ORCHESTRATOR: stub,
            SITE_HOST_SUFFIX: SUFFIX,
          } as unknown as Env,
          slow,
          {
            orgId: changes.orgId,
            session: {
              workosUserId: changes.workosUserId,
              sessionId: "session_probe",
              impersonated: false,
              email: "owner@changes-probe.invalid",
              name: "Probe Owner",
            },
          },
          "Change the hero.",
          crypto.randomUUID()
        )
        expect(response.status).toBe(503)
        expect(ErrorEnvelope.parse(await response.json()).code).toBe(
          "change.timeout"
        )
        expect(Date.now() - started).toBeLessThan(800)
        expect(stub.calls).toHaveLength(0)
      } finally {
        timer.restore()
        await late
      }
    })

    it("answers a key's settled build without reading how to route", async () => {
      const s = seed(kit, changes)
      const key = crypto.randomUUID()
      const made = await s.assignment("implementing", { key })
      // Any read of the open reviews fails, so only a skip answers 200.
      const blind: Tenancy = {
        ...kit,
        withOrg: (ctx, fn) =>
          kit.withOrg(ctx, (db) =>
            fn(
              new Proxy(db, {
                get(target, prop, receiver) {
                  const value = Reflect.get(target, prop, receiver)
                  if (prop !== "select") return value
                  return (...args: unknown[]) => {
                    const query = value.apply(target, args)
                    return new Proxy(query, {
                      get(q, p, r) {
                        const from = Reflect.get(q, p, r)
                        if (p !== "from") return from
                        return (table: unknown) => {
                          if (table === approvalRows) {
                            throw new Error("routed a settled build")
                          }
                          return from.call(q, table)
                        }
                      },
                    })
                  }
                },
              })
            )
          ),
      }
      const stub = stubOrchestrator()
      const response = await startChange(
        {
          ...env(url as string),
          ORCHESTRATOR: stub,
          SITE_HOST_SUFFIX: SUFFIX,
        } as unknown as Env,
        blind,
        {
          orgId: changes.orgId,
          session: {
            workosUserId: changes.workosUserId,
            sessionId: "session_probe",
            impersonated: false,
            email: "owner@changes-probe.invalid",
            name: "Probe Owner",
          },
        },
        "Change the hero.",
        key
      )
      expect(response.status).toBe(200)
      expect(BuildSummary.parse(await response.json()).assignment_id).toBe(made)
      expect(stub.calls).toHaveLength(0)
      await s.state(made, "cancelled")
    })

    it("answers a refused cancel as a conflict, and alerts with both builds", async () => {
      const { s, reviewing } = await reviewIn("awaiting_review", 72, 24)
      const { stub, made } = replacing(s, reviewing, {
        end: "refuse",
        cancel: "refuse",
      })
      const logged = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined)
      try {
        const response = await changes.call(
          stub,
          "/changes",
          json({ text: "Change the hero." })
        )
        expect(response.status).toBe(409)
        expect(ErrorEnvelope.parse(await response.json())).toMatchObject({
          class: "validation",
          code: "change.not_cancelled",
        })
        expect(logged).toHaveBeenCalledWith(
          JSON.stringify({
            alert: "change.not_cancelled",
            new_assignment_id: made.id,
            old_assignment_id: reviewing,
            status: 409,
          })
        )
      } finally {
        logged.mockRestore()
      }
      await s.state(reviewing, "cancelled")
      await s.state(made.id, "cancelled")
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
      // An org made before the team had neither the rows nor their hires.
      // The hires are append-only for `reme_app`, so this deletes as the
      // connecting role, which row security does not scope: every statement
      // names the org.
      await kit.withOrg({ orgId: bare.orgId }, async (db) => {
        await db.execute(sql`reset role`)
        const team = sql`(select ${staff.id} from ${staff} where ${staff.orgId} = ${bare.orgId} and ${staff.staffCode} in ('DEV-001', 'COS-001'))`
        await db.execute(
          sql`delete from staff_events where staff_id in ${team}`
        )
        await db.execute(sql`delete from events where staff_id in ${team}`)
        for (const code of ["DEV-001", "COS-001"]) {
          await db
            .delete(staff)
            .where(
              sql`${staff.orgId} = ${bare.orgId} and ${staff.staffCode} = ${code}`
            )
        }
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

    it("answers 503 transient when a success is off contract, since it may have happened", async () => {
      const stub = stubOrchestrator(() =>
        Response.json({ approval_id: "not a decision" }, { status: 202 })
      )
      const response = await busy.call(
        stub,
        `/approvals/${busyIds.review}/decision`,
        json({ decision: "approved", revision_id: crypto.randomUUID() })
      )
      expect(response.status).toBe(503)
      const body = ErrorEnvelope.parse(await response.json())
      expect(body.class).toBe("transient")
      expect(body.code).toBe("orchestrator.off_contract")
    })

    // Which question an answer reaches, and whether it repeats one, is the
    // orchestrator's call under the build's row lock. The api only relays it.
    const refusal = (status: number, code: string) => () =>
      Response.json(
        {
          class: status === 404 ? "resource" : "validation",
          code,
          message: "The orchestrator refused.",
          detail: {},
          occurred_at: new Date().toISOString(),
        },
        { status }
      )

    it("relays the builder's refusal of a question the build no longer waits on", async () => {
      const stub = stubOrchestrator(refusal(404, "request.not_found"))
      const stale = await asker.call(
        stub,
        `/builds/${askIds.asking}/answer`,
        json({ request_id: askIds.answered, value: "x" })
      )
      expect(stale.status).toBe(404)
      expect(ErrorEnvelope.parse(await stale.json()).code).toBe(
        "request.not_found"
      )
      expect(stub.calls).toHaveLength(1)
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

    it("sends an answer given again to the builder, which replays it", async () => {
      const receipt = {
        answer_id: crypto.randomUUID(),
        org_id: asker.orgId,
        assignment_id: askIds.asking,
        request_id: askIds.answered,
        fact_id: crypto.randomUUID(),
        answered_at: new Date().toISOString(),
      }
      const stub = stubOrchestrator(() =>
        Response.json(receipt, { status: 202 })
      )
      const response = await asker.call(
        stub,
        `/builds/${askIds.asking}/answer`,
        json({
          request_id: askIds.answered,
          value: { address: "owner@asker.invalid" },
        })
      )
      expect(response.status).toBe(202)
      expect(InformationAnswer.parse(await response.json())).toEqual(receipt)
      expect(stub.calls).toHaveLength(1)
    })

    it("relays the builder's receipt for a Blueprint decision", async () => {
      // What the orchestrator's `/blueprint` answers: the round and the decision.
      const stub = stubOrchestrator(() =>
        Response.json({ round: 1, decision: "build" }, { status: 202 })
      )
      const response = await asker.call(
        stub,
        `/builds/${askIds.asking}/blueprint`,
        json({ decision: "build" }, "blueprint-1")
      )
      expect(response.status).toBe(202)
      expect(await response.json()).toEqual({ round: 1, decision: "build" })
      expect(stub.calls[0]?.body).toEqual({ decision: "build" })
    })

    it("relays a preview that opens on the local router", async () => {
      const host = "preview-v1-brightclean.reme.localhost:3004"
      const link = {
        revision_id: crypto.randomUUID(),
        url: `http://${host}/open?t=abc.def`,
        screenshots: [390, 768, 1440].map(
          (w) => `http://${host}/screenshots/home-${w}.png?t=abc.def`
        ),
        expires_at: new Date().toISOString(),
      }
      const stub = stubOrchestrator(() => Response.json(link))
      const response = await asker.call(
        stub,
        `/builds/${askIds.asking}/preview`
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(link)
    })

    it.each([
      [500, 503, "transient", "orchestrator.unavailable"],
      // A 4xx outside the envelope is a route or shape mismatch: nothing
      // committed, and a retry would fail the same way.
      [404, 502, "integrity", "orchestrator.off_contract"],
    ])(
      "answers a bare %s from the builder as %s %s",
      async (given, status, errorClass, code) => {
        const stub = stubOrchestrator(
          () => new Response("upstream broke", { status: given })
        )
        const response = await asker.call(
          stub,
          `/builds/${askIds.asking}/preview`
        )
        expect(response.status).toBe(status)
        const body = ErrorEnvelope.parse(await response.json())
        expect([body.class, body.code]).toEqual([errorClass, code])
      }
    )

    it("relays the builder's refusal of a different answer to an answered question", async () => {
      const stub = stubOrchestrator(refusal(409, "answer.already_given"))
      const response = await asker.call(
        stub,
        `/builds/${askIds.asking}/answer`,
        json({ request_id: askIds.answered, value: { address: "a@b.invalid" } })
      )
      expect(response.status).toBe(409)
      expect(ErrorEnvelope.parse(await response.json()).code).toBe(
        "answer.already_given"
      )
      expect(stub.calls).toHaveLength(1)
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

describe("the questions on /workspace", () => {
  // The query leaves answered questions out and sorts by when each was asked,
  // then by build (packages/db's own tests hold it to that); readQuestions
  // takes its rows as they come.
  it("reads every blocked build's question in one query, in the query's order", async () => {
    const request = (n: number) => ({
      request_id: crypto.randomUUID(),
      org_id: crypto.randomUUID(),
      assignment_id: crypto.randomUUID(),
      requested_by_staff_id: crypto.randomUUID(),
      field: "business.parking",
      why: "The contact page names where to park.",
      answer_schema: { type: "string" },
      options: null,
      blocking: true,
      requested_at: `2026-09-2${n}T09:00:00.000Z`,
      expires_at: null,
    })
    // Whatever order the rows arrive in is the one shown; no second sort.
    const [first, second] = [request(7), request(5)]
    const rows = [first, second].map((asked) => ({
      assignment_id: asked.assignment_id,
      request: asked,
      answer: null,
      value: null,
      fact_id: null,
    }))
    const queries: unknown[] = []
    const db = {
      execute: async (query: unknown) => {
        queries.push(query)
        return rows
      },
    }
    const questions = await readQuestions(db as never)
    expect(queries).toHaveLength(1)
    expect(questions.map((q) => q.request.request_id)).toEqual([
      first.request_id,
      second.request_id,
    ])
  })
})
