import {
  COS_TOOLS,
  type CosToolName,
  FactValue,
  FactValueKey,
} from "@workspace/contracts"
import {
  assignments,
  sql,
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
import {
  answerQuestion,
  getFacts,
  getPreview,
  getWorkspace,
  requestChange,
  type ToolContext,
  ToolFailed,
} from "../src/cos/tools.ts"
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
 * The CoS's five tool bodies on a live connection, the orchestrator stood in
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
    return /https?:\/\//i.test(value) ? [`${at}: a URL`] : []
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, v]) => [
      ...(/(^|_)(org|staff)_id$/.test(key)
        ? [`${at}.${key}: a tenancy id`]
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
          approval
        )
      )
      const again = kept(
        "request_change",
        await requestChange(
          context(me, stub),
          { text: "Add Saturdays" },
          approval
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

    it("throws, never refuses, on an unknown outcome, and the rerun finds the one build", async () => {
      const approval = crypto.randomUUID()
      const hung = creating(me, true)
      const restore = deadline(300)
      let failed: unknown
      try {
        failed = await requestChange(
          context(me, hung),
          { text: "Add Mondays" },
          approval
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
          approval
        )
      )
      expect(again).toMatchObject({
        outcome: "started",
        build: { assignment_id: made },
      })
      expect(retry.calls).toHaveLength(0)
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
          crypto.randomUUID()
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

    /**
     * The orchestrator's `/answer` as it reads a value (`answers` in
     * `question.ts`): a fact field takes the fact's inner value, any other
     * field text. A key it has seen gets its stored receipt. `hang` leaves
     * the first call unanswered.
     */
    const answering = (fields: Record<string, string>, hang = false) => {
      const receipts = new Map<string, Response>()
      let calls = 0
      return stubOrchestrator(async (request) => {
        if (hang && calls++ === 0) return never()
        const key = request.headers.get("idempotency-key") ?? ""
        const stored = receipts.get(key)
        if (stored) return stored.clone()
        const body = (await request.clone().json()) as {
          request_id: string
          value: unknown
        }
        const field = fields[body.request_id]
        const fits =
          field !== undefined &&
          (FactValueKey.safeParse(field).success
            ? FactValue.safeParse({ key: field, value: body.value }).success
            : typeof body.value === "string")
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
        receipts.set(key, receipt.clone())
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

  // Last, over everything the cases above returned.
  it("returns nothing a model must not see, and only what each contract allows", () => {
    // The walk itself: bare and suffixed tenancy ids, and a link.
    expect(
      leaks({ org_id: 1, staff_id: 2, approver_staff_id: 3, note: HTTPS })
    ).toHaveLength(4)
    expect(new Set(seen.map(([tool]) => tool))).toEqual(
      new Set(Object.keys(COS_TOOLS))
    )
    for (const [tool, output] of seen) {
      expect(COS_TOOLS[tool].output.parse(output), tool).toEqual(output)
      expect(leaks(output), tool).toEqual([])
    }
  })
})
