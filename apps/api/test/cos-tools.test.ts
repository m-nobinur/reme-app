import {
  COS_TOOLS,
  type CosToolName,
  FactValue,
  FactValueKey,
  OwnerAnswerText,
} from "@workspace/contracts"
import {
  appendSessionEvent,
  assignments,
  domains,
  eq,
  facts,
  memberships,
  NEXT_DUE_KEY,
  reminders,
  sql,
  supersedeFact,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import type { ModelMessage } from "ai"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { settleCard } from "../src/build-questions.ts"
import { remember } from "../src/cos/memory.ts"
import { getIndexing, getSearchPerformance } from "../src/cos/search-tools.ts"
import {
  answerQuestion as answerTool,
  buyDomain,
  CONNECT_RETRY_MS,
  checkDomain,
  connectApproval,
  connectDomain,
  createReminder,
  findDomain,
  getFacts,
  getPreview,
  getWorkspace,
  newContact,
  ownersAnswer,
  paceOf,
  recordReview,
  removeDomain,
  requestChange,
  statedIn,
  type ToolContext,
  ToolFailed,
} from "../src/cos/tools.ts"
import { connectGoogle } from "../src/google.ts"
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
 * The CoS's tool bodies on a live connection, the orchestrator stood in
 * for. What they return is what the model reads, so every output is kept and
 * walked at the end for anything a model must never see.
 */

const url = process.env.DATABASE_URL

/** Every output any case produced, by tool. */
const seen: [CosToolName, unknown][] = []
const kept = <T>(tool: CosToolName, output: T): T => {
  seen.push([tool, output])
  return output
}

/** Keys and strings a model-visible value may not hold. */
function leaks(value: unknown, at = "$"): string[] {
  if (Array.isArray(value))
    return value.flatMap((v, i) => leaks(v, `${at}[${i}]`))
  if (typeof value === "string") {
    // The provider's settings link and Google's consent start are our own
    // allowlisted ones, shown on purpose.
    return /https?:\/\//i.test(value) &&
      !at.endsWith(".settings_url") &&
      !/^https:\/\/[^/]+\/api\/google\/start$/.test(value)
      ? [`${at}: a URL`]
      : []
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, v]) => [
      ...(/(^|_)(org|staff)_id$|^cf_/.test(key)
        ? [`${at}.${key}: a tenancy or Cloudflare id`]
        : []),
      ...leaks(v, `${at}.${key}`),
    ])
  }
  return []
}

const AT = new Date(Date.now() + 3_600_000).toISOString()
const HTTPS = "https://preview.invalid/signed?token=bearer"

/**
 * `AbortSignal.timeout`, run at `ms` so a case about the 10 s deadline takes
 * a moment.
 */
const deadline = (ms: number) => {
  const real = AbortSignal.timeout.bind(AbortSignal)
  const spy = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation(() => real(ms))
  return () => spy.mockRestore()
}
const never = () => new Promise<Response>(() => undefined)

describe("a claim the owner stated", () => {
  it.each([
    ["Local and fully insured", "we're local and fully insured", true],
    ["Not VAT registered", "We are not VAT registered", true],
    ["Insured", "we're not insured yet", false],
    ["Fully insured", "We aren't fully insured", false],
    ["Fully insured since 2009", "fully insured", false],
  ])("%s from %s: %s", (proof, message, stated) => {
    expect(statedIn(proof, message)).toBe(stated)
  })
})

describe("an answer the owner gave", () => {
  const said = ["Ring 0117 496 0125. We park on the street outside."]

  it("is their words, or the number they typed", () => {
    expect(ownersAnswer("street outside", said)).toBe(true)
    expect(ownersAnswer("a car park", said)).toBe(false)
    // Nothing of its own to check is no proof.
    expect(ownersAnswer("the", said)).toBe(false)
    // Every part of a value from one message, never pieced together.
    const area = { key: "service_area.text", value: { text: "Bristol" } }
    expect(ownersAnswer(area as never, ["Bristol and Bath"])).toBe(true)
    expect(
      ownersAnswer(
        {
          key: "service_area.radius",
          value: { centre: "Leeds", radius_km: 25 },
        } as never,
        ["We're in Leeds.", "About 25 miles out."]
      )
    ).toBe(false)
    const phone = (e164: string) =>
      ownersAnswer({ key: "business.phone", value: { e164 } }, said)
    expect(phone("+441174960125")).toBe(true)
    expect(phone("+441174960999")).toBe(false)
    expect(
      ownersAnswer(
        { key: "business.proof", value: { text: "Family run since 2009" } },
        said
      )
    ).toBe(false)
  })
})

describe("a build's pace", () => {
  const now = Date.parse("2026-10-25T01:00:00.000Z")
  const ago = (minutes: number) => now - minutes * 60_000
  const build = {
    state: "implementing" as const,
    lane: "full" as const,
    created_at: new Date(ago(40)).toISOString(),
    review_ms: 2 * 60_000,
  }
  const expected = {
    full: { p50: 420, p95: 900 },
    quick: { p50: 15, p95: 45 },
  }

  it("counts the minutes run without the owner's reviews, and the quiet since the last work", () => {
    const life = { work_ms: ago(12), resumed_ms: null, cause: null }
    expect(paceOf(build, life, expected, now)).toEqual({
      timing: {
        running_minutes: 38,
        quiet_minutes: 12,
        overdue: true,
        range: "about 39 to 47 minutes",
      },
    })
    expect(
      paceOf(
        { ...build, created_at: new Date(ago(10)).toISOString() },
        undefined,
        expected,
        now
      )
    ).toEqual({
      timing: {
        running_minutes: 8,
        quiet_minutes: 10,
        overdue: false,
        range: "about 7 to 15 minutes",
      },
    })
  })

  it("names the last restart, and whether the build has worked since", () => {
    const life = { work_ms: ago(1), resumed_ms: ago(3), cause: "stalled" }
    expect(paceOf(build, life, expected, now).restarted).toEqual({
      minutes_ago: 3,
      cause: "stalled",
      working: true,
    })
    expect(
      paceOf(build, { ...life, work_ms: ago(14), cause: "x" }, expected, now)
        .restarted
    ).toEqual({ minutes_ago: 3, cause: "other", working: false })
  })

  it("says nothing of a build waiting on the owner, and falls back to the measured lanes", () => {
    expect(
      paceOf({ ...build, state: "awaiting_review" }, undefined, expected, now)
    ).toEqual({})
    // 38 minutes is past the measured 6 to 10, so the range moves above it.
    expect(paceOf(build, undefined, undefined, now).timing).toMatchObject({
      overdue: true,
      range: "about 39 to 43 minutes",
    })
  })
})

describe.skipIf(!url)("the CoS tool bodies, on a live connection", () => {
  const kit: Tenancy = tenancy(url as string, { max: 2 })
  let realFetch: typeof fetch
  let me: Owner
  let other: Owner

  beforeAll(async () => {
    realFetch = globalThis.fetch
    globalThis.fetch = stubJwksFetch()
    me = await owner(kit, url as string, "cos-tools")
    other = await owner(kit, url as string, "cos-other")
  }, 60_000)

  afterAll(async () => {
    globalThis.fetch = realFetch
    await kit.close()
  })

  // Each case starts from orgs with nothing unfinished, so a case that fails
  // before its own clean-up does not change how the next one routes.
  afterEach(() =>
    Promise.all(
      [me, other].map((who) =>
        kit.withOrg({ orgId: who.orgId }, (db) =>
          db
            .update(assignments)
            .set({ state: "cancelled", updatedAt: new Date() })
            .where(
              sql`${assignments.state} not in ('published', 'failed', 'cancelled')`
            )
        )
      )
    )
  )

  const context = (
    who: Owner,
    stub: Stub = stubOrchestrator()
  ): ToolContext => ({
    env: {
      ...env(url as string),
      ORCHESTRATOR: stub,
      SITE_HOST_SUFFIX: SUFFIX,
    } as unknown as Env,
    kit,
    settleCard,
    owner: {
      orgId: who.orgId,
      session: {
        workosUserId: who.workosUserId,
        sessionId: "session_probe",
        impersonated: false,
        email: "owner@cos-probe.invalid",
        name: "Probe Owner",
      },
    },
  })

  /** A domain row for `who`, `check` its last check; its name, unique to this run. */
  const run = crypto.randomUUID().slice(0, 8)
  const domain = async (
    who: Owner,
    label: string,
    state: "awaiting_dns" | "active" | "removed",
    check: unknown = null
  ) => {
    const name = `${label}-${run}.example`
    await kit.withOrg({ orgId: who.orgId }, (db) =>
      db.insert(domains).values({
        orgId: who.orgId,
        siteId: crypto.randomUUID(),
        name,
        primaryHost: name,
        origin: "connected",
        method: "records",
        state,
        lastCheck: check,
      })
    )
    return name
  }

  /** A turn of a new conversation of `who`'s, as the agent hands it over. */
  const turnOf = async (who: Owner, said: string[] = []) => {
    const made = await who.call(stubOrchestrator(), "/conversations", {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
    })
    expect(made.status).toBe(201)
    const { id } = (await made.json()) as { id: string }
    // What the owner typed, as the turn's opening logged it.
    for (const [n, text] of said.entries()) {
      await kit.withOrg({ orgId: who.orgId }, (db) =>
        appendSessionEvent(db, {
          orgId: who.orgId,
          staffId: who.chiefId,
          assignmentId: null,
          sessionId: id,
          type: "cos.message",
          payload: {
            turn_id: "01J00000000000000000000000",
            message: {
              id: `owner-${n}`,
              role: "user",
              parts: [{ type: "text", text }],
            },
          },
          taint: ["untrusted_input"],
        })
      )
    }
    return {
      orgId: who.orgId,
      staffId: who.chiefId,
      sessionId: id,
      turnId: "01J00000000000000000000000",
    }
  }

  describe("get_workspace", () => {
    it("shows builds, questions and reviews without ids or links, and cuts a long why", async () => {
      const s = seed(kit, me)
      const asking = await s.assignment("blocked_on_information")
      await s.revision(asking, 1)
      const request = {
        ...question(me, asking),
        field: `custom.${"f".repeat(900)}`,
        why: `Needed for the footer. ${"x".repeat(900)}`,
      }
      await s.event(asking, "information.requested", request)
      await s.blocked(asking, request.request_id, 4)
      const output = kept("get_workspace", await getWorkspace(context(me), {}))
      expect(COS_TOOLS.get_workspace.output.parse(output)).toEqual(output)
      expect(output.builds).toContainEqual(
        expect.objectContaining({ assignment_id: asking, version: 1 })
      )
      const [asked] = output.questions
      expect(asked?.request_id).toBe(request.request_id)
      expect(asked?.why).toHaveLength(500)
      expect(asked?.why.startsWith("Needed for the footer.")).toBe(true)
      expect(asked?.field).toHaveLength(500)
      await s.state(asking, "cancelled")
    })

    it.each([
      ["twelve options", Array.from({ length: 12 }, (_, i) => `Option ${i}`)],
      ["a blank option", ["Mondays", "   "]],
    ])(
      "drops a stored question's options when they hold %s, and logs it",
      async (_name, options) => {
        const s = seed(kit, me)
        const asking = await s.assignment("blocked_on_information")
        const request = {
          ...question(me, asking, "custom.days"),
          answer_schema: { type: "string" },
          options,
        }
        await s.event(asking, "information.requested", request)
        await s.blocked(asking, request.request_id, 4)
        const logged = vi
          .spyOn(console, "warn")
          .mockImplementation(() => undefined)
        try {
          const output = kept(
            "get_workspace",
            await getWorkspace(context(me), {})
          )
          expect(output.questions).toContainEqual(
            expect.objectContaining({
              request_id: request.request_id,
              options: null,
            })
          )
          expect(logged).toHaveBeenCalledWith(
            JSON.stringify({
              code: "cos.options_skipped",
              request_id: request.request_id,
            })
          )
        } finally {
          logged.mockRestore()
        }
      }
    )

    it("shows an org with nothing yet an empty workspace", async () => {
      const fresh = await owner(kit, url as string, "cos-empty")
      const output = kept(
        "get_workspace",
        await getWorkspace(context(fresh), {})
      )
      expect(output).toEqual({
        site: { host: null, live_version: null },
        builds: [],
        stopped: [],
        questions: [],
        approvals: [],
        missing_facts: expect.any(Array),
        domains: [],
        tasks: [],
        expected_seconds: expect.any(Object),
        expected_range: {
          quick: "about 1 to 2 minutes",
          full: "about 6 to 10 minutes",
        },
      })
      expect(output.missing_facts.length).toBeGreaterThan(0)
    })

    it("lists the org's domains newest first, without removed ones or another org's", async () => {
      const mine = await owner(kit, url as string, "cos-domains")
      const stranger = await owner(kit, url as string, "cos-domains-other")
      const older = await domain(mine, "older", "awaiting_dns")
      await domain(mine, "gone", "removed")
      const newer = await domain(mine, "newer", "active", { status: "valid" })
      await domain(stranger, "theirs", "active")
      const output = kept(
        "get_workspace",
        await getWorkspace(context(mine), {})
      )
      expect(output.domains).toEqual([
        {
          name: newer,
          state: "active",
          last_check: { status: "valid" },
        },
        { name: older, state: "awaiting_dns", last_check: null },
      ])
    })

    it("cuts a why at a character, never through one", async () => {
      const s = seed(kit, me)
      const asking = await s.assignment("blocked_on_information")
      const request = {
        ...question(me, asking),
        why: `${"x".repeat(499)}\u{1F600}tail`,
      }
      await s.event(asking, "information.requested", request)
      await s.blocked(asking, request.request_id, 4)
      const output = kept("get_workspace", await getWorkspace(context(me), {}))
      expect(output.questions[0]?.why).toBe("x".repeat(499))
    })

    it("says how long a working build has run, its quiet and its last restart", async () => {
      const s = seed(kit, me)
      const working = await s.assignment("implementing")
      await s.event(working, "runtime.turn", {}, 0.25)
      await s.event(
        working,
        "agent.note",
        { kind: "resumed", cause: "stalled" },
        0.1
      )
      const paceNow = async () =>
        kept("get_workspace", await getWorkspace(context(me), {})).builds.find(
          (b) => b.assignment_id === working
        )
      // The note is not work: the build has been quiet since the turn.
      expect(await paceNow()).toMatchObject({
        timing: { running_minutes: 0, quiet_minutes: 15, overdue: false },
        restarted: { minutes_ago: 6, cause: "stalled", working: false },
      })
      await s.event(working, "runtime.turn", {})
      expect(await paceNow()).toMatchObject({
        timing: { quiet_minutes: 0 },
        restarted: { working: true },
      })
      await s.state(working, "cancelled")
    })

    it("shows another org nothing of this one's", async () => {
      const s = seed(kit, me)
      const mine = await s.assignment("queued")
      const output = kept(
        "get_workspace",
        await getWorkspace(context(other), {})
      )
      expect(output.builds.map((b) => b.assignment_id)).not.toContain(mine)
      await s.state(mine, "cancelled")
    })
  })

  describe("get_facts", () => {
    it("lists the current values, and skips and counts a row the contract now refuses", async () => {
      await kit.withOrg({ orgId: me.orgId }, async (db) => {
        await supersedeFact(db, {
          orgId: me.orgId,
          key: "business.name",
          factType: "business",
          value: { name: "Sparkle Probe Cleaning (fixture)" },
          provenance: { source: "owner_stated", confidence: 1 },
        })
        // Stored before the rule that hours close after they open.
        await supersedeFact(db, {
          orgId: me.orgId,
          key: "hours.weekday",
          factType: "hours",
          value: { open: "17:00", close: "09:00" },
          provenance: { source: "owner_stated", confidence: 1 },
        })
      })
      const logged = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined)
      try {
        const output = kept("get_facts", await getFacts(context(me), {}))
        expect(COS_TOOLS.get_facts.output.parse(output)).toEqual(output)
        expect(output.facts).toContainEqual({
          key: "business.name",
          value: { name: "Sparkle Probe Cleaning (fixture)" },
        })
        expect(output.facts.map((f) => f.key)).not.toContain("hours.weekday")
        expect(logged).toHaveBeenCalledWith(
          JSON.stringify({
            code: "cos.facts_skipped",
            count: 1,
            keys: ["hours.weekday"],
          })
        )
      } finally {
        logged.mockRestore()
      }
    })
  })

  describe("get_preview", () => {
    it("answers ready with the version and expiry, and no link", async () => {
      const s = seed(kit, me)
      const build = await s.assignment("preview_ready")
      const revision = await s.revision(build, 3)
      const stub = stubOrchestrator(() =>
        Response.json({
          revision_id: revision,
          url: HTTPS,
          screenshots: [HTTPS, HTTPS, HTTPS],
          expires_at: AT,
        })
      )
      const output = kept(
        "get_preview",
        await getPreview(context(me, stub), { assignment_id: build })
      )
      expect(output).toEqual({
        outcome: "ready",
        assignment_id: build,
        version: 3,
        expires_at: AT,
      })
      await s.state(build, "cancelled")
    })

    it("refuses as the closed shape when there is no preview yet", async () => {
      const s = seed(kit, me)
      const build = await s.assignment("implementing")
      const stub = stubOrchestrator(() =>
        Response.json(
          {
            class: "validation",
            code: "revision.building",
            message: "This revision has no artifact to preview yet.",
            detail: { revision_id: crypto.randomUUID(), url: HTTPS },
            occurred_at: AT,
          },
          { status: 409 }
        )
      )
      const output = kept(
        "get_preview",
        await getPreview(context(me, stub), { assignment_id: build })
      )
      expect(output).toEqual({
        outcome: "refused",
        error: {
          class: "validation",
          code: "revision.building",
          message: "This revision has no artifact to preview yet.",
        },
      })
      await s.state(build, "cancelled")
    })

    it("throws, never refuses, when the builder names a revision the org does not hold", async () => {
      const s = seed(kit, me)
      const build = await s.assignment("preview_ready")
      const stub = stubOrchestrator(() =>
        Response.json({
          revision_id: crypto.randomUUID(),
          url: HTTPS,
          screenshots: [HTTPS, HTTPS, HTTPS],
          expires_at: AT,
        })
      )
      const failed = await getPreview(context(me, stub), {
        assignment_id: build,
      }).catch((error: unknown) => error)
      expect(failed).toBeInstanceOf(ToolFailed)
      expect((failed as ToolFailed).error).toMatchObject({
        class: "integrity",
        code: "orchestrator.off_contract",
      })
    })

    it("refuses another org's build without calling the orchestrator", async () => {
      const s = seed(kit, other)
      const theirs = await s.assignment("preview_ready")
      const stub = stubOrchestrator()
      const output = kept(
        "get_preview",
        await getPreview(context(me, stub), { assignment_id: theirs })
      )
      expect(output).toMatchObject({
        outcome: "refused",
        error: { class: "resource", code: "assignment.not_found" },
      })
      expect(stub.calls).toHaveLength(0)
      await s.state(theirs, "cancelled")
    })
  })

  describe("request_change", () => {
    /** Every build `creating` made. */
    const built: string[] = []
    /** Makes the build under the caller's key, as the orchestrator does. */
    const creating = (who: Owner, hang = false) => {
      const s = seed(kit, who)
      return stubOrchestrator(async (request) => {
        const key = request.headers.get("idempotency-key") ?? ""
        const id = await s.assignment("queued", { key })
        built.push(id)
        // Committed, then never answered: the outcome is unknown.
        if (hang) return never()
        const body = (await request.clone().json()) as { goal: string }
        return Response.json(
          {
            assignment_id: id,
            org_id: who.orgId,
            staff_id: who.devId,
            created_by_staff_id: who.chiefId,
            parent_assignment_id: null,
            revision_of_assignment_id: null,
            kind: "site.build",
            state: "queued",
            expected_version: 0,
            goal: body.goal,
            acceptance_criteria: ["probe"],
            fact_snapshot_id: crypto.randomUUID(),
            pack_refs: [],
            budget_usd: 5,
            deadline: null,
            priority: "normal",
            created_at: AT,
            updated_at: AT,
          },
          { status: 201 }
        )
      })
    }

    it("makes one build for one approval id, however often it runs", async () => {
      const approval = crypto.randomUUID()
      const stub = creating(me)
      const first = kept(
        "request_change",
        await requestChange(
          context(me, stub),
          { text: "Add Saturdays" },
          approval,
          await turnOf(me)
        )
      )
      const again = kept(
        "request_change",
        await requestChange(
          context(me, stub),
          { text: "Add Saturdays" },
          approval,
          await turnOf(me)
        )
      )
      // The second run finds the build the key made and replays it.
      const made = built.at(-1)
      expect(first).toMatchObject({
        outcome: "started",
        build: { assignment_id: made },
      })
      expect(again).toMatchObject({
        outcome: "started",
        build: { assignment_id: made },
      })
      expect(stub.calls).toHaveLength(1)
      expect(stub.calls[0]?.request.headers.get("idempotency-key")).toBe(
        approval
      )
    })

    it("sends the change's label with the build and returns it on the summary", async () => {
      const stub = creating(me)
      const output = kept(
        "request_change",
        await requestChange(
          context(me, stub),
          {
            text: "Make the hero title more professional",
            label: "your hero title",
          },
          crypto.randomUUID(),
          await turnOf(me)
        )
      )
      expect(output).toMatchObject({
        outcome: "started",
        build: { label: "your hero title" },
      })
      expect(stub.calls[0]?.body).toMatchObject({
        label: "your hero title",
      })
    })

    it("throws, never refuses, on an unknown outcome, and the rerun finds the one build", async () => {
      const approval = crypto.randomUUID()
      const hung = creating(me, true)
      const restore = deadline(300)
      let failed: unknown
      try {
        failed = await requestChange(
          context(me, hung),
          { text: "Add Mondays" },
          approval,
          await turnOf(me)
        ).catch((error: unknown) => error)
      } finally {
        restore()
      }
      expect(failed).toBeInstanceOf(ToolFailed)
      expect(failed).toMatchObject({
        status: 503,
        error: { class: "transient", code: "orchestrator.timeout" },
      })
      const made = built.at(-1)
      const retry = creating(me)
      const again = kept(
        "request_change",
        await requestChange(
          context(me, retry),
          { text: "Add Mondays" },
          approval,
          await turnOf(me)
        )
      )
      expect(again).toMatchObject({
        outcome: "started",
        build: { assignment_id: made },
      })
      expect(retry.calls).toHaveLength(0)
    })

    const phoneNow = async () =>
      (await getFacts(context(me), {})).facts.find(
        (f) => f.key === "business.phone"
      )?.value

    it("records a number the owner typed in full as their fact, then starts the change", async () => {
      await kit.withOrg({ orgId: me.orgId }, (db) =>
        supersedeFact(db, {
          orgId: me.orgId,
          key: "business.phone",
          factType: "business",
          value: { e164: "+441174960123" },
          provenance: { source: "owner_stated", confidence: 1 },
        })
      )
      const turn = await turnOf(me, [
        "Please change the phone number on the website to 0117 496 0124",
      ])
      const stub = creating(me)
      const approval = crypto.randomUUID()
      const input = {
        text: "Change the phone number to 0117 496 0124",
        change_kind: "copy",
        contact: { phone: "+441174960124" },
      } as const
      const output = kept(
        "request_change",
        await requestChange(context(me, stub), input, approval, turn)
      )
      expect(output).toMatchObject({ outcome: "started" })
      expect(await phoneNow()).toEqual({ e164: "+441174960124" })
      // A replay under the same approval restates the same value and writes nothing.
      await requestChange(context(me, stub), input, approval, turn)
      const [held] = await kit.withOrg({ orgId: me.orgId }, (db) =>
        db
          .select()
          .from(facts)
          .where(eq(facts.key, "business.phone"))
          .orderBy(sql`${facts.version} desc`)
      )
      expect(held?.value).toEqual({ e164: "+441174960124" })
      expect(held?.provenanceSource).toBe("owner_stated")
    })

    it("starts a change whose contact only restates the held phone and email, recording nothing", async () => {
      await kit.withOrg({ orgId: me.orgId }, async (db) => {
        for (const [key, value] of [
          ["business.phone", { e164: "+441174960150" }],
          ["business.email", { address: "hello@held.example" }],
        ] as const)
          await supersedeFact(db, {
            orgId: me.orgId,
            key,
            factType: "business",
            value,
            provenance: { source: "owner_stated", confidence: 1 },
          })
      })
      const versions = async () =>
        (
          await kit.withOrg({ orgId: me.orgId }, (db) =>
            db.select().from(facts).where(eq(facts.key, "business.phone"))
          )
        ).length
      const before = await versions()
      // Typed in another conversation, so this one's log holds neither.
      const turn = await turnOf(me, ["Change the hero to say hello"])
      const stub = creating(me)
      const output = kept(
        "request_change",
        await requestChange(
          context(me, stub),
          {
            text: "Change the hero to say hello",
            change_kind: "copy",
            contact: { phone: "+441174960150", email: "Hello@held.example" },
          },
          crypto.randomUUID(),
          turn
        )
      )
      expect(output).toMatchObject({ outcome: "started" })
      expect(await versions()).toBe(before)
    })

    it.each([
      'Change the hero to say "Spotless homes"',
      "Don't call us a family firm, just say we're local",
    ])(
      "starts a change whose text never touches contact, dropping the contact the model added: %s",
      async (text) => {
        const before = await phoneNow()
        const turn = await turnOf(me, [text])
        const stub = creating(me)
        const output = kept(
          "request_change",
          await requestChange(
            context(me, stub),
            {
              text,
              change_kind: "copy",
              contact: { phone: "+447700900222", email: "made@up.example" },
            },
            crypto.randomUUID(),
            turn
          )
        )
        expect(output).toMatchObject({ outcome: "started" })
        expect(await phoneNow()).toEqual(before)
      }
    )

    // The owner typed a phone number: a different one is refused for the
    // model to correct. An email when they typed none is dropped (above).
    it.each([
      ["phone", { phone: "+441174960199" }],
      ["email", { email: "someone@invented.example", phone: "+441174960199" }],
    ])(
      "refuses a %s the owner never typed, changes no fact and starts nothing",
      async (_what, contact) => {
        const before = await phoneNow()
        const turn = await turnOf(me, [
          "Change the phone number to 0117 496 0124",
        ])
        const stub = creating(me)
        const output = kept(
          "request_change",
          await requestChange(
            context(me, stub),
            { text: "Change the contact details", contact },
            crypto.randomUUID(),
            turn
          )
        )
        expect(output).toMatchObject({
          outcome: "refused",
          error: { class: "validation", code: "contact.not_typed" },
        })
        // The model is told how out: without contact when the owner gave none.
        expect(
          (output as { error: { message: string } }).error.message
        ).toContain("propose the change again without contact")
        expect(stub.calls).toHaveLength(0)
        expect(await phoneNow()).toEqual(before)
      }
    )

    it("drops a phone and email the owner never typed anywhere, so the change needs no yes", async () => {
      const said = "Add our opening hours to the contact page"
      expect(
        await newContact(
          context(me),
          {
            text: "Add opening hours to the contact page",
            contact: { phone: "+441423555019", email: "hello@example.co.uk" },
          },
          said
        )
      ).toBeNull()
    })

    it("refuses a typed number the change text the owner approves does not name", async () => {
      const turn = await turnOf(me, [
        "Change the phone number to 0117 496 0125",
      ])
      const stub = creating(me)
      const output = await requestChange(
        context(me, stub),
        {
          text: "Update the contact details",
          contact: { phone: "+441174960125" },
        },
        crypto.randomUUID(),
        turn
      )
      expect(output).toMatchObject({
        outcome: "refused",
        error: { code: "contact.not_typed" },
      })
      expect(stub.calls).toHaveLength(0)
    })

    const proofNow = async () =>
      (await getFacts(context(me), {})).facts.find(
        (f) => f.key === "business.proof"
      )?.value

    it("records the owner's claims as their proof before the change starts, once, after what the site already says", async () => {
      await kit.withOrg({ orgId: me.orgId }, (db) =>
        supersedeFact(db, {
          orgId: me.orgId,
          key: "business.proof",
          factType: "business",
          value: { text: "Family run since 2009." },
          provenance: { source: "owner_stated", confidence: 1 },
        })
      )
      const input = {
        text: "Say we're local and fully insured",
        change_kind: "copy" as const,
        proof: "Local and fully insured, with £5 million public liability",
      }
      const turn = await turnOf(me, [
        "Can you say we're local and fully insured? 5 million pounds public liability.",
      ])
      // A retry records nothing twice.
      const key = crypto.randomUUID()
      for (const _ of [1, 2]) {
        const output = kept(
          "request_change",
          await requestChange(context(me, creating(me)), input, key, turn)
        )
        expect(output).toMatchObject({ outcome: "started" })
      }
      expect(await proofNow()).toEqual({
        text: "Family run since 2009. Local and fully insured, with £5 million public liability",
      })
    })

    it.each([
      ["Remove it", "Yes, remove it please."],
      ["Please start again", "Please start again, it got stuck."],
    ])(
      "drops the instruction %s as a claim and still starts the change",
      async (proof, said) => {
        const before = await proofNow()
        const output = kept(
          "request_change",
          await requestChange(
            context(me, creating(me)),
            { text: "Remove the stray text from the facts", proof },
            crypto.randomUUID(),
            await turnOf(me, [said])
          )
        )
        expect(output).toMatchObject({ outcome: "started" })
        expect(await proofNow()).toEqual(before)
      }
    )

    it("drops a claim that is only the change restated, and still starts the change", async () => {
      const before = await proofNow()
      const turn = await turnOf(me, [
        "That build got stuck, please start the website again.",
      ])
      const output = kept(
        "request_change",
        await requestChange(
          context(me, creating(me)),
          { text: "Build the website again", proof: "Build the website again" },
          crypto.randomUUID(),
          turn
        )
      )
      expect(output).toMatchObject({ outcome: "started" })
      expect(await proofNow()).toEqual(before)
    })

    it("drops a claim with a word the owner never wrote, records nothing and still starts the change", async () => {
      const before = await proofNow()
      const turn = await turnOf(me, ["Say we're insured"])
      const stub = creating(me)
      const output = kept(
        "request_change",
        await requestChange(
          context(me, stub),
          { text: "Say we're insured", proof: "Fully insured since 2001" },
          crypto.randomUUID(),
          turn
        )
      )
      expect(output).toMatchObject({ outcome: "started" })
      expect(stub.calls).toHaveLength(1)
      expect(await proofNow()).toEqual(before)
    })

    it("refuses as the closed shape, detail dropped", async () => {
      const stub = stubOrchestrator(() =>
        Response.json(
          {
            class: "budgetary",
            code: "builds.daily_cap",
            message: "A business starts at most 20 builds in 24 hours.",
            detail: { org_id: me.orgId, max: 20 },
            occurred_at: AT,
          },
          { status: 429 }
        )
      )
      const output = kept(
        "request_change",
        await requestChange(
          context(me, stub),
          { text: "Add Sundays" },
          crypto.randomUUID(),
          await turnOf(me)
        )
      )
      expect(output).toEqual({
        outcome: "refused",
        error: {
          class: "budgetary",
          code: "builds.daily_cap",
          message: "A business starts at most 20 builds in 24 hours.",
        },
      })
    })
  })

  describe("answer_question", () => {
    const PHONE = {
      key: "business.phone",
      value: { e164: "+441234567890" },
    } as const
    const EMAIL = {
      key: "business.email",
      value: { address: "owner@cos-probe.invalid" },
    } as const

    /** A turn whose owner wrote every answer these cases give. */
    let spoke: Promise<{ sessionId: string }> | undefined
    const answerQuestion = async (
      ctx: Parameters<typeof answerTool>[0],
      input: Parameters<typeof answerTool>[1],
      key: string,
      turn?: { sessionId: string }
    ) => {
      spoke ??= turnOf(me, [
        "Ring 01234 567890 or email owner@cos-probe.invalid. We're shut on Mondays.",
      ])
      return answerTool(ctx, input, key, turn ?? (await spoke))
    }

    it("refuses an answer the owner never wrote, without calling the orchestrator", async () => {
      const { s, asking, waited } = await blocked(me)
      const stub = answering({ [waited.request_id]: waited.field })
      const typed = await turnOf(me, ["Our number is changing soon."])
      const output = kept(
        "answer_question",
        await answerQuestion(
          context(me, stub),
          { request_id: waited.request_id, value: PHONE },
          crypto.randomUUID(),
          typed
        )
      )
      expect(output).toMatchObject({
        outcome: "refused",
        error: { code: "answer.not_owners" },
      })
      expect(stub.calls).toHaveLength(0)
      await s.state(asking, "cancelled")
    })

    /**
     * The orchestrator's `/answer` as it reads a value (`answers` in its
     * `question.ts`, which its own tests cover): a fact field takes the
     * fact's inner value in that key's shape, and any other field the
     * owner's text. A retry is replayed by what it says, the request id and
     * the value, as the orchestrator replays it; the key is only carried.
     * `hang` leaves the first call unanswered.
     */
    const answering = (fields: Record<string, string>, hang = false) => {
      const receipts = new Map<string, Response>()
      let calls = 0
      return stubOrchestrator(async (request) => {
        if (hang && calls++ === 0) return never()
        const body = (await request.clone().json()) as {
          request_id: string
          value: unknown
        }
        const said = `${body.request_id} ${JSON.stringify(body.value)}`
        const stored = receipts.get(said)
        if (stored) return stored.clone()
        const field = fields[body.request_id]
        const fits =
          field !== undefined &&
          (FactValueKey.safeParse(field).success
            ? FactValue.safeParse({ key: field, value: body.value }).success
            : OwnerAnswerText.safeParse(body.value).success)
        if (!fits) {
          return Response.json(
            {
              class: "validation",
              code: "answer.invalid",
              message: "That answer does not fit the question.",
              detail: {},
              occurred_at: AT,
            },
            { status: 400 }
          )
        }
        const receipt = Response.json(
          {
            answer_id: crypto.randomUUID(),
            org_id: me.orgId,
            assignment_id: new URL(request.url).pathname.split("/")[2],
            request_id: body.request_id,
            fact_id: crypto.randomUUID(),
            answered_at: AT,
          },
          { status: 202 }
        )
        receipts.set(said, receipt.clone())
        return receipt
      })
    }

    const blocked = async (who: Owner) => {
      const s = seed(kit, who)
      const asking = await s.assignment("blocked_on_information")
      const earlier = question(who, asking, "business.email")
      await s.event(asking, "information.requested", earlier)
      await s.blocked(asking, earlier.request_id, 4)
      await s.transition(asking, "blocked_on_information", "implementing", 5)
      const waited = question(who, asking)
      await s.event(asking, "information.requested", waited)
      await s.blocked(asking, waited.request_id, 6)
      return { s, asking, earlier, waited }
    }

    it("answers the question the build waits on, keyed by the approval", async () => {
      const { s, asking, waited } = await blocked(me)
      const approval = crypto.randomUUID()
      const stub = answering({ [waited.request_id]: waited.field })
      const output = kept(
        "answer_question",
        await answerQuestion(
          context(me, stub),
          { request_id: waited.request_id, value: PHONE },
          approval
        )
      )
      expect(output).toEqual({
        outcome: "answered",
        request_id: waited.request_id,
      })
      expect(stub.calls).toHaveLength(1)
      const [call] = stub.calls
      expect(new URL(call?.request.url as string).pathname).toBe(
        `/assignments/${asking}/answer`
      )
      expect(call?.request.headers.get("idempotency-key")).toBe(approval)
      // The fact's inner value, as the orchestrator reads it for the field.
      expect(call?.body).toEqual({
        request_id: waited.request_id,
        value: PHONE.value,
      })
      await s.state(asking, "cancelled")
    })

    it("leaves which question may be answered to the orchestrator", async () => {
      const { s, asking, earlier } = await blocked(me)
      const stub = stubOrchestrator(() =>
        Response.json(
          {
            class: "resource",
            code: "request.not_found",
            message: "This build is not waiting on that question.",
            detail: { request_id: earlier.request_id },
            occurred_at: AT,
          },
          { status: 404 }
        )
      )
      const output = kept(
        "answer_question",
        await answerQuestion(
          context(me, stub),
          { request_id: earlier.request_id, value: EMAIL },
          crypto.randomUUID()
        )
      )
      expect(output).toEqual({
        outcome: "refused",
        error: {
          class: "resource",
          code: "request.not_found",
          message: "This build is not waiting on that question.",
        },
      })
      expect(new URL(stub.calls[0]?.request.url as string).pathname).toBe(
        `/assignments/${asking}/answer`
      )
      await s.state(asking, "cancelled")
    })

    it("replays an approval's receipt after the build has moved to a newer question", async () => {
      const { s, asking, waited } = await blocked(me)
      const approval = crypto.randomUUID()
      const stub = answering({ [waited.request_id]: waited.field })
      const input = { request_id: waited.request_id, value: PHONE }
      const first = kept(
        "answer_question",
        await answerQuestion(context(me, stub), input, approval)
      )
      // The build woke on the answer and has since asked something new.
      await s.transition(asking, "blocked_on_information", "implementing", 7)
      const newer = question(me, asking, "business.email")
      await s.event(asking, "information.requested", newer)
      await s.blocked(asking, newer.request_id, 8)
      const again = kept(
        "answer_question",
        await answerQuestion(context(me, stub), input, approval)
      )
      expect(again).toEqual(first)
      expect(again).toEqual({
        outcome: "answered",
        request_id: waited.request_id,
      })
      expect(
        stub.calls.map((c) => c.request.headers.get("idempotency-key"))
      ).toEqual([approval, approval])
      await s.state(asking, "cancelled")
    })

    it("throws, never refuses, on a bare 500 from the orchestrator", async () => {
      const { s, asking, waited } = await blocked(me)
      const stub = stubOrchestrator(
        () => new Response("upstream broke", { status: 500 })
      )
      const logged = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined)
      let failed: unknown
      try {
        failed = await answerQuestion(
          context(me, stub),
          { request_id: waited.request_id, value: PHONE },
          crypto.randomUUID()
        ).catch((error: unknown) => error)
      } finally {
        logged.mockRestore()
      }
      expect(failed).toBeInstanceOf(ToolFailed)
      expect(failed).toMatchObject({
        status: 503,
        error: { class: "transient", code: "orchestrator.unavailable" },
      })
      await s.state(asking, "cancelled")
    })

    it("throws, never refuses, on an unknown outcome, and the rerun answers under the same key", async () => {
      const { s, asking, waited } = await blocked(me)
      const approval = crypto.randomUUID()
      const stub = answering({ [waited.request_id]: waited.field }, true)
      const input = { request_id: waited.request_id, value: PHONE }
      const restore = deadline(300)
      let failed: unknown
      try {
        failed = await answerQuestion(context(me, stub), input, approval).catch(
          (error: unknown) => error
        )
      } finally {
        restore()
      }
      expect(failed).toBeInstanceOf(ToolFailed)
      expect(failed).toMatchObject({
        status: 503,
        error: { class: "transient", code: "orchestrator.timeout" },
      })
      const again = kept(
        "answer_question",
        await answerQuestion(context(me, stub), input, approval)
      )
      expect(again).toEqual({
        outcome: "answered",
        request_id: waited.request_id,
      })
      expect(
        stub.calls.map((c) => c.request.headers.get("idempotency-key"))
      ).toEqual([approval, approval])
      await s.state(asking, "cancelled")
    })

    it.each([
      ["a fact for another key", EMAIL],
      ["text for a fact", "Mondays"],
    ])("refuses %s without calling the orchestrator", async (_name, value) => {
      const { s, asking, waited } = await blocked(me)
      const stub = answering({ [waited.request_id]: waited.field })
      const output = kept(
        "answer_question",
        await answerQuestion(
          context(me, stub),
          { request_id: waited.request_id, value },
          crypto.randomUUID()
        )
      )
      expect(output).toEqual({
        outcome: "refused",
        error: {
          class: "validation",
          code: "answer.invalid",
          message: "That answer does not fit the question.",
        },
      })
      expect(stub.calls).toHaveLength(0)
      await s.state(asking, "cancelled")
    })

    it("refuses a review, which only record_review's card may store", async () => {
      const s = seed(kit, me)
      const asking = await s.assignment("blocked_on_information")
      const asked = question(me, asking, "testimonials.review_1")
      await s.event(asking, "information.requested", asked)
      const stub = answering({ [asked.request_id]: asked.field })
      const output = kept(
        "answer_question",
        await answerQuestion(
          context(me, stub),
          {
            request_id: asked.request_id,
            value: {
              key: "testimonials.review_1",
              value: { quote: "Spotless.", name: "Ann", permission: true },
            },
          },
          crypto.randomUUID()
        )
      )
      expect(output).toMatchObject({
        outcome: "refused",
        error: { class: "validation", code: "answer.review" },
      })
      expect(stub.calls).toHaveLength(0)
      await s.state(asking, "cancelled")
    })

    it("refuses an id no build asked, without calling the orchestrator", async () => {
      const stub = stubOrchestrator()
      const output = kept(
        "answer_question",
        await answerQuestion(
          context(me, stub),
          { request_id: crypto.randomUUID(), value: "Mondays" },
          crypto.randomUUID()
        )
      )
      expect(output).toMatchObject({
        outcome: "refused",
        error: { class: "resource", code: "request.not_found" },
      })
      expect(stub.calls).toHaveLength(0)
    })

    it("refuses another org's question without calling the orchestrator", async () => {
      const { s, asking, waited } = await blocked(other)
      const stub = stubOrchestrator()
      const output = kept(
        "answer_question",
        await answerQuestion(
          context(me, stub),
          { request_id: waited.request_id, value: "Mondays" },
          crypto.randomUUID()
        )
      )
      expect(output).toMatchObject({
        outcome: "refused",
        error: { code: "request.not_found" },
      })
      expect(stub.calls).toHaveLength(0)
      await s.state(asking, "cancelled")
    })

    it("maps an orchestrator refusal onto the closed shape", async () => {
      const { s, asking, waited } = await blocked(me)
      const stub = stubOrchestrator(() =>
        Response.json(
          {
            class: "validation",
            code: "answer.already_given",
            message: "That question has been answered.",
            detail: { request_id: waited.request_id },
            occurred_at: AT,
          },
          { status: 409 }
        )
      )
      const output = kept(
        "answer_question",
        await answerQuestion(
          context(me, stub),
          { request_id: waited.request_id, value: PHONE },
          crypto.randomUUID()
        )
      )
      expect(output).toEqual({
        outcome: "refused",
        error: {
          class: "validation",
          code: "answer.already_given",
          message: "That question has been answered.",
        },
      })
      await s.state(asking, "cancelled")
    })
  })

  describe("create_reminder", () => {
    const rowsKeyed = (who: Owner, key: string) =>
      kit.withOrg({ orgId: who.orgId }, (db) =>
        db.select().from(reminders).where(eq(reminders.idempotencyKey, key))
      )
    const DUE = new Date(Date.now() + 86_400_000).toISOString()

    it("stores one row for one approval, however often it runs, under the turn's conversation and the CoS", async () => {
      const turn = await turnOf(me)
      const approval = crypto.randomUUID()
      const input = { title: "Call the supplier", due_at: DUE }
      const first = kept(
        "create_reminder",
        await createReminder(context(me), input, approval, turn, null)
      )
      const again = await createReminder(
        context(me),
        { title: "Something else", due_at: null },
        approval,
        turn,
        null
      )
      expect(first).toEqual({ outcome: "created", due_at: DUE })
      expect(again).toEqual(first)
      const rows = await rowsKeyed(me, `approval:${approval}`)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        title: "Call the supplier",
        source: "assistant",
        conversationId: turn.sessionId,
        createdByStaffId: me.chiefId,
      })
    })

    it("lowers the scheduler's guard to the due time, so the reminder fires within the minute", async () => {
      const map = new Map([
        [NEXT_DUE_KEY, JSON.stringify({ next: Date.now() + 9e9, scanned: 0 })],
      ])
      const kv = {
        get: async (key: string) => JSON.parse(map.get(key) ?? "null"),
        put: async (key: string, value: string) => void map.set(key, value),
      }
      const base = context(me)
      const input = { title: "Ring the plumber", due_at: DUE }
      await createReminder(
        { ...base, env: { ...base.env, SCHEDULE: kv } as unknown as Env },
        input,
        crypto.randomUUID(),
        await turnOf(me),
        null
      )
      expect(JSON.parse(map.get(NEXT_DUE_KEY) as string).next).toBe(
        Date.parse(DUE)
      )
    })

    it("never replays the owner's own reminder keyed by the bare approval id", async () => {
      const turn = await turnOf(me)
      const approval = crypto.randomUUID()
      const posted = await me.call(stubOrchestrator(), "/reminders", {
        method: "POST",
        headers: { "idempotency-key": approval },
        body: JSON.stringify({ title: "The owner's own", due_at: null }),
      })
      expect(posted.status).toBe(201)
      const output = await createReminder(
        context(me),
        { title: "Call the supplier", due_at: DUE },
        approval,
        turn,
        null
      )
      expect(output).toEqual({ outcome: "created", due_at: DUE })
      const [owners] = await rowsKeyed(me, approval)
      const [tools] = await rowsKeyed(me, `approval:${approval}`)
      expect(owners).toMatchObject({
        title: "The owner's own",
        source: "owner",
      })
      expect(tools).toMatchObject({
        title: "Call the supplier",
        source: "assistant",
      })
    })

    it("refuses a due time in the past as the closed shape, and stores nothing", async () => {
      const turn = await turnOf(me)
      const approval = crypto.randomUUID()
      const output = kept(
        "create_reminder",
        await createReminder(
          context(me),
          {
            title: "Call the supplier",
            due_at: new Date(Date.now() - 86_400_000).toISOString(),
          },
          approval,
          turn,
          null
        )
      )
      expect(output).toEqual({
        outcome: "refused",
        error: {
          class: "validation",
          code: "reminder.due_past",
          message: "A reminder cannot be due in the past.",
        },
      })
      expect(await rowsKeyed(me, `approval:${approval}`)).toHaveLength(0)
    })

    it("throws, never refuses, when the database refuses the write", async () => {
      // A staff id the org does not hold: the foreign key refuses the row.
      const turn = { ...(await turnOf(me)), staffId: crypto.randomUUID() }
      const logged = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined)
      let failed: unknown
      try {
        failed = await createReminder(
          context(me),
          { title: "Call the supplier", due_at: null },
          crypto.randomUUID(),
          turn,
          null
        ).catch((error: unknown) => error)
      } finally {
        logged.mockRestore()
      }
      expect(failed).toBeInstanceOf(ToolFailed)
      expect(failed).toMatchObject({
        status: 503,
        error: { class: "transient", code: "reminder.unconfirmed" },
      })
    })

    it("reads due_at as the owner's wall time in the turn's zone, or as UTC with none", async () => {
      const turn = await turnOf(me)
      const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
      // The model wrote the owner's 09:00 with the wrong offset.
      const written = `${day}T09:00:00+00:00`
      const nine = Date.parse(`${day}T09:00:00Z`)
      const zoned = await createReminder(
        context(me),
        { title: "Call the supplier", due_at: written },
        crypto.randomUUID(),
        turn,
        "Asia/Kathmandu"
      )
      expect(zoned).toEqual({
        outcome: "created",
        due_at: new Date(nine - (5 * 60 + 45) * 60_000).toISOString(),
      })
      const utc = await createReminder(
        context(me),
        { title: "Call the supplier", due_at: `${day}T09:00:00-04:00` },
        crypto.randomUUID(),
        turn,
        null
      )
      expect(utc).toEqual({
        outcome: "created",
        due_at: new Date(nine).toISOString(),
      })
    })
  })

  describe("record_review", () => {
    const versions = (who: Owner, key: string) =>
      kit.withOrg({ orgId: who.orgId }, (db) =>
        db
          .select({
            value: facts.value,
            version: facts.version,
            source: facts.provenanceSource,
            validTo: facts.validTo,
          })
          .from(facts)
          .where(eq(facts.key, key))
          .orderBy(facts.version)
      )
    const MARTA = {
      quote: "They worked around my hours and the kitchen shines.",
      name: "Marta L.",
      permission: true,
    } as const

    it("stores the owner's review in its slot once, however often it runs, and replaces it on a new one", async () => {
      const first = kept(
        "record_review",
        await recordReview(context(me), { slot: 1, ...MARTA })
      )
      expect(await recordReview(context(me), { slot: 1, ...MARTA })).toEqual(
        first
      )
      expect(first).toEqual({ outcome: "recorded", slot: 1 })
      expect(await versions(me, "testimonials.review_1")).toEqual([
        { value: MARTA, version: 1, source: "owner_stated", validTo: null },
      ])

      const owen = {
        quote: "Simple to book.",
        name: "Owen",
        permission: true,
      } as const
      await recordReview(context(me), { slot: 1, ...owen })
      const rows = await versions(me, "testimonials.review_1")
      expect(rows.map((r) => [r.version, r.value, r.validTo === null])).toEqual(
        [
          [1, MARTA, false],
          [2, owen, true],
        ]
      )
      expect(await versions(me, "testimonials.review_2")).toEqual([])
      expect(await versions(other, "testimonials.review_1")).toEqual([])
      expect((await getFacts(context(me), {})).facts).toContainEqual({
        key: "testimonials.review_1",
        value: owen,
      })
    })
  })

  describe("check_domain", () => {
    const checked = {
      outcome: "checked",
      state: "awaiting_dns",
      status: { status: "pending_verification" },
      next_step: "Add the CNAME record at your DNS provider.",
    }

    it("wakes the domain's check and returns its state, status and next step", async () => {
      const name = await domain(me, "check", "awaiting_dns")
      const stub = stubOrchestrator(() => Response.json(checked))
      const output = kept(
        "check_domain",
        await checkDomain(context(me, stub), { name })
      )
      expect(output).toEqual(checked)
      const [call] = stub.calls
      expect(call?.request.method).toBe("POST")
      expect(new URL(call?.request.url ?? "").pathname).toBe(
        `/assignments/domains/${name}/check`
      )
    })

    it("refuses another org's domain, a removed one and an unknown one without calling the orchestrator", async () => {
      const theirs = await domain(other, "theirs-check", "awaiting_dns")
      const gone = await domain(me, "gone-check", "removed")
      const stub = stubOrchestrator(() => Response.json(checked))
      for (const name of [theirs, gone, `none-${run}.example`]) {
        expect(
          kept("check_domain", await checkDomain(context(me, stub), { name }))
        ).toMatchObject({
          outcome: "refused",
          error: { class: "resource", code: "domain.not_found" },
        })
      }
      expect(stub.calls).toHaveLength(0)
    })

    it("throws, never refuses, on a 500 from the orchestrator", async () => {
      const name = await domain(me, "down", "awaiting_dns")
      const stub = stubOrchestrator(() =>
        Response.json(
          {
            class: "transient",
            code: "orchestrator.unavailable",
            message: "down",
            detail: {},
            occurred_at: AT,
          },
          { status: 503 }
        )
      )
      await expect(
        checkDomain(context(me, stub), { name })
      ).rejects.toBeInstanceOf(ToolFailed)
    })
  })

  describe("connect_domain", () => {
    const connecting = {
      outcome: "connecting",
      method: "records",
      email_affected: false,
      steps: [{ type: "CNAME", name: "www", value: "sites.reme.example" }],
      apex: "forward",
      provider: { name: "GoDaddy", settings_url: "https://dcc.godaddy.com/" },
    }

    it("sends the name under the approval as body and key, and returns the contract's output", async () => {
      const approval = crypto.randomUUID()
      const stub = stubOrchestrator(() => Response.json(connecting))
      const output = kept(
        "connect_domain",
        await connectDomain(
          context(me, stub),
          { name: "sparkleclean.co.uk" },
          approval
        )
      )
      expect(output).toEqual(connecting)
      const [call] = stub.calls
      expect(call?.request.method).toBe("POST")
      expect(new URL(call?.request.url ?? "").pathname).toBe(
        "/assignments/domains"
      )
      expect(call?.request.headers.get("idempotency-key")).toBe(approval)
      expect(call?.body).toEqual({
        name: "sparkleclean.co.uk",
        approval_id: approval,
      })
      // The org comes from the session on the bridge, never from the body.
      expect(call?.request.headers.get("x-reme-org-id")).toBe(me.orgId)
    })

    describe("approval", () => {
      const sure = (noul: number) =>
        (async () =>
          Response.json({
            answers: { puts_it_on: { type: "noul", noul } },
          })) as unknown as typeof fetch
      const keyed = (who: Owner) => ({
        ...context(who),
        env: { ...context(who).env, OPENROUTER_API_KEY: "k" } as Env,
      })
      /** The owner's typed `text` is in the log; `messages` is what the model saw. */
      const asked = async (
        who: Owner,
        name: string,
        text: string,
        { noul = 0.97, messages = [] as ModelMessage[] } = {}
      ) =>
        connectApproval(
          keyed(who),
          { name },
          (await turnOf(who, [text])).sessionId,
          messages,
          sure(noul)
        )

      beforeEach(() => {
        vi.spyOn(console, "log").mockImplementation(() => undefined)
      })

      it("runs with no card when Jev is sure the owner put the site on that name", async () => {
        expect(
          await asked(me, "sparkleclean.co.uk", "Put it on sparkleclean.co.uk")
        ).toBe("not-applicable")
      })

      it("shows the card when Jev is unsure, the name is not in the message, or the key is missing", async () => {
        const text = "what about sparkleclean.co.uk?"
        expect(await asked(me, "sparkleclean.co.uk", text, { noul: 0.4 })).toBe(
          "user-approval"
        )
        expect(
          await asked(me, "sparkleclean.co.uk", "put it on my domain")
        ).toBe("user-approval")
        const { sessionId } = await turnOf(me, ["Put it on sparkleclean.co.uk"])
        expect(
          await connectApproval(
            context(me),
            { name: "sparkleclean.co.uk" },
            sessionId,
            []
          )
        ).toBe("user-approval")
      })

      it("asks again for a connect already proposed since the owner's message, as after a no", async () => {
        const called: ModelMessage[] = [
          { role: "user", content: "Put it on sparkleclean.co.uk" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "c1",
                toolName: "connect_domain",
                input: { name: "sparkleclean.co.uk" },
              },
            ],
          },
        ]
        expect(
          await asked(
            me,
            "sparkleclean.co.uk",
            "Put it on sparkleclean.co.uk",
            {
              messages: called,
            }
          )
        ).toBe("user-approval")
      })

      it("does not take an emailed reply as the owner's yes", async () => {
        const { sessionId } = await turnOf(me)
        await kit.withOrg({ orgId: me.orgId }, (db) =>
          appendSessionEvent(db, {
            orgId: me.orgId,
            staffId: me.chiefId,
            assignmentId: null,
            sessionId,
            type: "cos.message",
            payload: {
              turn_id: "01J00000000000000000000000",
              message: {
                id: "eml_1",
                role: "user",
                parts: [{ type: "text", text: "Put it on sparkleclean.co.uk" }],
              },
            },
            taint: ["untrusted_input"],
          })
        )
        expect(
          await connectApproval(
            keyed(me),
            { name: "sparkleclean.co.uk" },
            sessionId,
            [],
            sure(0.99)
          )
        ).toBe("user-approval")
      })

      it("always asks for a domain the org already has live, but not one still connecting or removed", async () => {
        const live = await domain(me, "floor-live", "active")
        const waiting = await domain(me, "floor-wait", "awaiting_dns")
        const gone = await domain(me, "floor-gone", "removed")
        const put = (name: string) => asked(me, name, `Put the site on ${name}`)
        expect(await put(live)).toBe("user-approval")
        expect(await put(waiting)).toBe("not-applicable")
        expect(await put(gone)).toBe("not-applicable")
        // Another org's live domain is no floor for this one.
        const theirs = await domain(other, "floor-theirs", "active")
        expect(await put(theirs)).toBe("not-applicable")
      })
    })

    it.each([
      [409, "domain.in_use", "resource"],
      [429, "domain.too_many_pending", "budgetary"],
      [409, "site.not_published", "resource"],
      [400, "domain.invalid", "validation"],
    ])(
      "refuses as the closed shape on %i %s, detail dropped",
      async (status, code, cls) => {
        const stub = stubOrchestrator(() =>
          Response.json(
            {
              class: cls,
              code,
              message: "Not this one.",
              detail: { org_id: other.orgId },
              occurred_at: AT,
            },
            { status }
          )
        )
        const output = kept(
          "connect_domain",
          await connectDomain(
            context(me, stub),
            { name: "taken.example" },
            crypto.randomUUID()
          )
        )
        expect(output).toEqual({
          outcome: "refused",
          error: { class: cls, code, message: "Not this one." },
        })
      }
    )

    const passing = (code: string) =>
      Response.json(
        {
          class: "transient",
          code,
          message: "Try again in a minute.",
          detail: {},
          occurred_at: AT,
        },
        { status: 503 }
      )

    /** A connect whose first answer is `first`, then `then`, run past the retry pause. */
    async function connectThrough(first: Response, then: () => Response) {
      const answers = [first]
      const stub = stubOrchestrator(() => answers.shift() ?? then())
      vi.useFakeTimers({ toFake: ["setTimeout"] })
      try {
        const connected = connectDomain(
          context(me, stub),
          { name: "blip.example" },
          "approval-blip"
        ).then(
          (output) => ({ output, error: null }),
          (error: unknown) => ({ output: null, error })
        )
        await vi.advanceTimersByTimeAsync(CONNECT_RETRY_MS)
        return { ...(await connected), stub }
      } finally {
        vi.useRealTimers()
      }
    }

    it.each(["dns.unavailable", "domain.records_pending"])(
      "asks once more under the same key after a passing %s, so one approval survives it",
      async (code) => {
        const { output, stub } = await connectThrough(passing(code), () =>
          Response.json(connecting)
        )
        expect(kept("connect_domain", output)).toEqual(connecting)
        expect(
          stub.calls.map((c) => c.request.headers.get("idempotency-key"))
        ).toEqual(["approval-blip", "approval-blip"])
      }
    )

    it("throws when the second look fails too, and never retries any other 503", async () => {
      const twice = await connectThrough(passing("dns.unavailable"), () =>
        passing("dns.unavailable")
      )
      expect(twice.error).toBeInstanceOf(ToolFailed)
      expect(twice.stub.calls).toHaveLength(2)
      const down = await connectThrough(
        passing("orchestrator.unavailable"),
        () => Response.json(connecting)
      )
      expect(down.error).toBeInstanceOf(ToolFailed)
      expect(down.stub.calls).toHaveLength(1)
    })

    it("throws, never refuses, when the orchestrator answers off the contract", async () => {
      const stub = stubOrchestrator(() =>
        Response.json({ ...connecting, cf_hostname_id: "abc" })
      )
      await expect(
        connectDomain(
          context(me, stub),
          { name: "odd.example" },
          crypto.randomUUID()
        )
      ).rejects.toBeInstanceOf(ToolFailed)
    })
  })

  describe("remove_domain", () => {
    it("deletes the domain under the approval as key, and says it is removed", async () => {
      const approval = crypto.randomUUID()
      const stub = stubOrchestrator(() => new Response(null, { status: 204 }))
      const output = kept(
        "remove_domain",
        await removeDomain(
          context(me, stub),
          { name: "sparkleclean.co.uk" },
          approval
        )
      )
      expect(output).toEqual({ outcome: "removed" })
      const [call] = stub.calls
      expect(call?.request.method).toBe("DELETE")
      expect(new URL(call?.request.url ?? "").pathname).toBe(
        "/assignments/domains/sparkleclean.co.uk"
      )
      expect(call?.request.headers.get("idempotency-key")).toBe(approval)
    })

    it("refuses as the closed shape when the orchestrator holds no such domain, and throws on a 503", async () => {
      const refusal = stubOrchestrator(() =>
        Response.json(
          {
            class: "resource",
            code: "domain.not_found",
            message: "gone.example isn't connected to this site.",
            detail: { org_id: other.orgId },
            occurred_at: AT,
          },
          { status: 404 }
        )
      )
      expect(
        kept(
          "remove_domain",
          await removeDomain(
            context(me, refusal),
            { name: "gone.example" },
            crypto.randomUUID()
          )
        )
      ).toEqual({
        outcome: "refused",
        error: {
          class: "resource",
          code: "domain.not_found",
          message: "gone.example isn't connected to this site.",
        },
      })
      const down = stubOrchestrator(() =>
        Response.json(
          {
            class: "transient",
            code: "orchestrator.unavailable",
            message: "down",
            detail: {},
            occurred_at: AT,
          },
          { status: 503 }
        )
      )
      await expect(
        removeDomain(
          context(me, down),
          { name: "gone.example" },
          crypto.randomUUID()
        )
      ).rejects.toBeInstanceOf(ToolFailed)
    })
  })

  describe("find_domain and buy_domain", () => {
    const paying = (who: Owner, stub: Stub): ToolContext => {
      const base = context(who, stub)
      return {
        ...base,
        env: {
          ...base.env,
          STRIPE_SECRET_KEY: "sk_fixture",
          STRIPE_WEBHOOK_SECRET: "whsec_fix",
        },
      }
    }
    const registrant = {
      registrant: {
        name: "Jane Smith",
        email: "jane@sparkle.invalid",
        phone: "+447700900123",
        address: {
          street: "12 Mill Lane",
          city: "Bristol",
          postal_code: "BS1 4AB",
          country_code: "GB",
        },
      },
    }

    it("find_domain relays the orchestrator's offers, with or without the Stripe keys", async () => {
      const found = {
        outcome: "found",
        best: { name: "sparkleclean.com", price_gbp_year: 12, why: "Short." },
        options: [
          { name: "sparkleclean.net", price_gbp_year: 12, why: "Close." },
        ],
      }
      const stub = stubOrchestrator(() => Response.json(found))
      expect(
        kept(
          "find_domain",
          await findDomain(context(me, stub), { query: "sparkle" })
        )
      ).toEqual(found)
      const [call] = stub.calls
      expect(new URL(call?.request.url ?? "").pathname).toBe(
        "/assignments/domains/find"
      )
      expect(call?.body).toEqual({ query: "sparkle" })
    })

    it("buy_domain prepares the purchase keyed by the call, and charges nothing", async () => {
      const answer = {
        outcome: "awaiting_payment",
        name: "sparkleclean.com",
        price_gbp: 12,
        checkout: "embedded",
      }
      const stub = stubOrchestrator(() =>
        Response.json(answer, { status: 201 })
      )
      const input = { name: "sparkleclean.com", ...registrant }
      expect(
        kept(
          "buy_domain",
          await buyDomain(paying(me, stub), input, "toolu_buy_1")
        )
      ).toEqual(answer)
      const [call] = stub.calls
      expect(new URL(call?.request.url ?? "").pathname).toBe(
        "/assignments/domains/buy"
      )
      expect(call?.request.headers.get("idempotency-key")).toBe("toolu_buy_1")
      expect(call?.body).toEqual(input)
    })

    it("buy_domain refuses without the Stripe keys and for a member who is not the owner, before the orchestrator", async () => {
      const quiet = stubOrchestrator()
      const input = { name: "sparkleclean.com", ...registrant }
      expect(
        kept(
          "buy_domain",
          await buyDomain(context(me, quiet), input, "toolu_buy_2")
        )
      ).toEqual({
        outcome: "refused",
        error: {
          class: "resource",
          code: "domain.buy_unavailable",
          message: "Buying a domain isn't available yet.",
        },
      })
      const member = await owner(kit, url as string, "cos-member")
      await kit.withOrg({ orgId: member.orgId }, (db) =>
        db
          .update(memberships)
          .set({ role: "member" })
          .where(sql`${memberships.orgId} = ${member.orgId}`)
      )
      expect(
        await buyDomain(paying(member, quiet), input, "toolu_buy_3")
      ).toMatchObject({
        outcome: "refused",
        error: { code: "domain.not_owner" },
      })
      expect(quiet.calls).toEqual([])
    })
  })

  // The tools' stored answers are tested in cos-search-tools.test.ts; this
  // keeps their outputs in the walk for anything a model must never see.
  it("the Search Console tools answer an org that never connected", async () => {
    expect(
      kept(
        "get_search_performance",
        await getSearchPerformance(context(me), { days: 28, by: "query" })
      )
    ).toEqual({ connected: false })
    expect(kept("get_indexing", await getIndexing(context(me), {}))).toEqual({
      connected: false,
    })
  })

  it("connect_google gives the owner Google's consent start, on our own web origin", async () => {
    const base = context(me)
    const output = kept(
      "connect_google",
      await connectGoogle(
        {
          ...base,
          env: {
            ...base.env,
            GOOGLE_CLIENT_ID: "client",
            WEB_ORIGIN: "https://staging.remeai.co.uk",
          },
        },
        {}
      )
    )
    expect(output).toEqual({
      url: "https://staging.remeai.co.uk/api/google/start",
    })
  })

  describe("remember", () => {
    it("saves a line of the owner's profile and answers that the write is complete", async () => {
      const output = kept(
        "remember",
        await remember(
          context(me),
          { operations: [{ action: "add", text: "Prefers calls after 4pm" }] },
          "",
          await turnOf(me, ["I prefer calls after 4pm."])
        )
      )
      expect(COS_TOOLS.remember.output.parse(output)).toEqual(output)
      expect(output).toMatchObject({ outcome: "saved" })
    })
  })

  // Last, over everything the cases above returned.
  it("returns nothing a model must not see, and only what each contract allows", () => {
    // The walk itself: bare and suffixed tenancy ids, a Cloudflare id and a
    // link, but not the provider's settings link.
    expect(
      leaks({
        org_id: 1,
        staff_id: 2,
        approver_staff_id: 3,
        cf_hostname_id: 4,
        note: HTTPS,
        provider: { settings_url: HTTPS },
      })
    ).toHaveLength(5)
    expect(new Set(seen.map(([tool]) => tool))).toEqual(
      new Set(Object.keys(COS_TOOLS))
    )
    for (const [tool, output] of seen) {
      expect(COS_TOOLS[tool].output.parse(output), tool).toEqual(output)
      expect(leaks(output), tool).toEqual([])
    }
  })
})
