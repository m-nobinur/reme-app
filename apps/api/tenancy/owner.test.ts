import {
  ActivityFeed,
  Conversation,
  ConversationHistory,
  ConversationList,
  ErrorEnvelope,
  FactList,
  OWNER_BRIDGE_HEADERS,
  Reminder,
  WorkspaceStatus,
} from "@workspace/contracts"
import { events, sql, staffEvents, tenancy } from "@workspace/db"
import { MockLanguageModelV4 } from "ai/test"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { chat } from "../src/chat.ts"
import { appendMessages } from "../src/conversations.ts"
import {
  type Owner,
  owner,
  question,
  seed,
  stubOrchestrator,
} from "../test/owner-fixture.ts"
import { env, stubJwksFetch } from "../test/sealed-session.ts"

/**
 * Cross-org denial on the owner routes, and the bridge carrying the
 * session's org and nothing a client sent. Part of the blocking tenancy
 * gate, beside `cross-org.test.ts`.
 *
 * An id from another org has to be refused here, before the binding: the
 * orchestrator would refuse it too, but a request that crossed the binding
 * for another tenant's row is already a request this worker should not
 * have sent. So every refusal below also asserts the stub saw nothing, and
 * the same routes on the org's own ids are the control that the stub is
 * reachable at all.
 */

const url = process.env.DATABASE_URL
if (!url) {
  throw new Error(
    "DATABASE_URL is not set, so the owner-route gate has nothing to deny against. " +
      "It is blocking and cannot be skipped: start Postgres, then rerun pnpm test:tenancy."
  )
}

const kit = tenancy(url, { max: 2 })
let realFetch: typeof fetch
let mine: Owner
let theirs: Owner
let theirAlert: string
const ids: Record<
  "mine" | "theirs",
  { build: string; approval: string; asking: string; request: string }
> = {
  mine: { build: "", approval: "", asking: "", request: "" },
  theirs: { build: "", approval: "", asking: "", request: "" },
}

beforeAll(async () => {
  realFetch = globalThis.fetch
  globalThis.fetch = stubJwksFetch()
  mine = await owner(kit, url, "tenancy-mine")
  theirs = await owner(kit, url, "tenancy-theirs")
  for (const [name, who] of [
    ["mine", mine],
    ["theirs", theirs],
  ] as const) {
    const s = seed(kit, who)
    const build = await s.assignment("awaiting_review")
    const revision = await s.revision(build, 1)
    // A build waiting on a question, for the answer route. Not a site
    // build, since the site lock allows one writer and the review holds it.
    const asking = await s.assignment("blocked_on_information", {
      kind: "probe.ask",
    })
    const asked = question(who, asking)
    await s.event(asking, "information.requested", asked)
    await s.blocked(asking, asked.request_id, 1)
    ids[name] = {
      build,
      approval: await s.approval(build, revision, 72),
      asking,
      request: asked.request_id,
    }
  }
  const s = seed(kit, theirs)
  const failed = await s.assignment("failed")
  theirAlert = await s.event(failed, "assignment.state_changed", {
    from: "validating",
    to: "failed",
  })
  await theirs.call(stubOrchestrator(), "/facts", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      facts: [{ key: "business.name", value: { name: "Theirs (fixture)" } }],
    }),
  })
}, 60_000)

afterAll(async () => {
  globalThis.fetch = realFetch
  await kit.close()
})

const routes = (which: "mine" | "theirs"): [string, RequestInit][] => {
  const { build, approval, asking, request } = ids[which]
  const post = (body: unknown) => ({
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  })
  return [
    [`/builds/${asking}/answer`, post({ request_id: request, value: "x" })],
    [`/builds/${build}/cancel`, post({})],
    [`/builds/${build}/preview`, { method: "GET" }],
    [
      `/approvals/${approval}/decision`,
      post({ decision: "approved", revision_id: crypto.randomUUID() }),
    ],
  ]
}

describe("another org's id is 404 and never reaches the binding", () => {
  it.each([0, 1, 2, 3])("route %i", async (n) => {
    const [path, init] = routes("theirs")[n] as [string, RequestInit]
    const stub = stubOrchestrator()
    const response = await mine.call(stub, path, init)
    expect(response.status, path).toBe(404)
    expect(ErrorEnvelope.parse(await response.json()).class).toBe("resource")
    expect(stub.calls, path).toHaveLength(0)
  })

  it.each([0, 1, 2, 3])(
    "control: the org's own id reaches it, route %i",
    async (n) => {
      const [path, init] = routes("mine")[n] as [string, RequestInit]
      const stub = stubOrchestrator()
      await mine.call(stub, path, init)
      expect(stub.calls, path).toHaveLength(1)
    }
  )
})

describe("the owner's reads are the owner's org", () => {
  it("lists only this org's builds and approvals in the workspace", async () => {
    const body = WorkspaceStatus.parse(
      await (await mine.call(stubOrchestrator(), "/workspace")).json()
    )
    expect(body.builds.map((b) => b.assignment_id)).toEqual([ids.mine.build])
    const approvals = body.attention.flatMap((item) =>
      item.kind === "approval" ? [item.request] : []
    )
    expect(approvals.map((a) => a.approval_id)).toEqual([ids.mine.approval])
    for (const a of approvals) expect(a.org_id).toBe(mine.orgId)
  })

  it("lists none of another org's reports or alerts as activity", async () => {
    const activity = async (who: Owner) =>
      ActivityFeed.parse(
        await (await who.call(stubOrchestrator(), "/activity")).json()
      ).items.map((item) => item.event_id)
    expect(await activity(theirs)).toContain(theirAlert)
    expect(await activity(mine)).not.toContain(theirAlert)
  })

  it("lists none of another org's facts", async () => {
    const { facts } = FactList.parse(
      await (await mine.call(stubOrchestrator(), "/facts")).json()
    )
    expect(facts.filter((f) => f.org_id !== mine.orgId)).toEqual([])
    const own = FactList.parse(
      await (await theirs.call(stubOrchestrator(), "/facts")).json()
    )
    expect(own.facts.map((f) => f.key)).toEqual(["business.name"])
  })
})

describe("the bridge carries the session and nothing the client sent", () => {
  it("sends the session's ids, whatever headers the client forged", async () => {
    const stub = stubOrchestrator()
    await mine.call(stub, `/builds/${ids.mine.build}/cancel`, {
      method: "POST",
      headers: {
        [OWNER_BRIDGE_HEADERS.orgId]: theirs.orgId,
        [OWNER_BRIDGE_HEADERS.workosUserId]: theirs.workosUserId,
        [OWNER_BRIDGE_HEADERS.sessionId]: "session_forged",
        "cloudflare-workers-version-overrides":
          'reme-orchestrator="00000000-0000-4000-8000-000000000000"',
        "idempotency-key": "cancel-forged-1",
        "x-reme-anything": "forged",
      },
    })
    expect(stub.calls).toHaveLength(1)
    const sent = stub.calls[0]?.request.headers as Headers
    expect(sent.get(OWNER_BRIDGE_HEADERS.orgId)).toBe(mine.orgId)
    expect(sent.get(OWNER_BRIDGE_HEADERS.workosUserId)).toBe(mine.workosUserId)
    expect(sent.get(OWNER_BRIDGE_HEADERS.sessionId)).toBe(
      `session_${mine.workosUserId}`
    )
    expect(sent.get("idempotency-key")).toBe("cancel-forged-1")
    expect(sent.has("cloudflare-workers-version-overrides")).toBe(false)
    expect(sent.has("cookie")).toBe(false)
    expect([...sent.keys()].sort()).toEqual(
      [
        OWNER_BRIDGE_HEADERS.orgId,
        OWNER_BRIDGE_HEADERS.sessionId,
        OWNER_BRIDGE_HEADERS.workosUserId,
        "idempotency-key",
      ].sort()
    )
  })
})

describe("another org's conversation is 404 and never written to", () => {
  const keyed = (
    method: string,
    body?: unknown,
    key = crypto.randomUUID()
  ) => ({
    method,
    headers: { "content-type": "application/json", "idempotency-key": key },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const create = async (who: Owner, key?: string) =>
    Conversation.parse(
      await (
        await who.call(
          stubOrchestrator(),
          "/conversations",
          keyed("POST", undefined, key)
        )
      ).json()
    )
  const history = async (who: Owner, id: string) =>
    ConversationHistory.parse(
      await (
        await who.call(stubOrchestrator(), `/conversations/${id}/messages`)
      ).json()
    ).messages

  it("refuses to read, rename or list it", async () => {
    const theirConversation = await create(theirs)
    for (const [path, init] of [
      [`/conversations/${theirConversation.id}`, { method: "GET" }],
      [`/conversations/${theirConversation.id}/messages`, { method: "GET" }],
      [
        `/conversations/${theirConversation.id}`,
        keyed("PATCH", { title: "Taken over" }),
      ],
    ] as const) {
      const response = await mine.call(stubOrchestrator(), path, init)
      expect(response.status, `${init.method} ${path}`).toBe(404)
      expect(ErrorEnvelope.parse(await response.json()).code).toBe(
        "conversation.not_found"
      )
    }
    const kept = Conversation.parse(
      await (
        await theirs.call(
          stubOrchestrator(),
          `/conversations/${theirConversation.id}`
        )
      ).json()
    )
    expect(kept.title).toBeNull()
    const listed = ConversationList.parse(
      await (await mine.call(stubOrchestrator(), "/conversations")).json()
    )
    expect(listed.conversations.map((c) => c.id)).not.toContain(
      theirConversation.id
    )
  })

  it("makes a new conversation for a key another org already used", async () => {
    const key = `__LOCALID_${crypto.randomUUID()}`
    const theirConversation = await create(theirs, key)
    const mineConversation = await create(mine, key)
    expect(mineConversation.id).not.toBe(theirConversation.id)
  })

  it("writes no message into it, whatever the ids", async () => {
    const theirConversation = await create(theirs)
    const message = {
      id: "u_1",
      parent_id: null,
      format: "ai-sdk/v6",
      content: { role: "user", parts: [{ type: "text", text: "x" }] },
    } as const
    await appendMessages(kit, theirs.orgId, theirConversation.id, [message])
    const refused = (await appendMessages(
      kit,
      mine.orgId,
      theirConversation.id,
      [{ ...message, id: "u_2", parent_id: "u_1" }, message]
    )) as Response
    expect(refused.status).toBe(404)
    expect(ErrorEnvelope.parse(await refused.json()).detail).toEqual({})
    expect(
      (await history(theirs, theirConversation.id)).map((m) => m.id)
    ).toEqual(["u_1"])
  })

  it("reaches no model for a turn in it", async () => {
    const theirConversation = await create(theirs)
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("the model was called")
      },
    })
    const stub = stubOrchestrator()
    const refused = await chat(
      new Request("http://api.invalid/chat", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: theirConversation.id,
          mode: "act",
          turn: { kind: "message", message_id: "u_cos", text: "Hello" },
        }),
      }),
      {
        ...env(url),
        ORCHESTRATOR: stub,
        SITE_HOST_SUFFIX: "-stg.remeai.co.uk",
      } as unknown as Env,
      kit,
      {
        orgId: mine.orgId,
        session: {
          workosUserId: mine.workosUserId,
          sessionId: "session_probe",
          impersonated: false,
          email: "owner@tenancy-probe.invalid",
          name: "Probe Owner",
        },
      },
      { model }
    )
    expect(refused.status).toBe(404)
    expect(ErrorEnvelope.parse(await refused.json()).code).toBe(
      "conversation.not_found"
    )
    expect(model.doStreamCalls).toHaveLength(0)
    expect(await history(theirs, theirConversation.id)).toEqual([])
  })

  it("takes no chat turn in it, of any kind", async () => {
    const list = ConversationList.parse(
      await (await theirs.call(stubOrchestrator(), "/conversations")).json()
    )
    const onboarding = list.conversations.find((c) => c.kind === "onboarding")
    const theirId = onboarding?.id as string
    const before = await history(theirs, theirId)
    const tail = before.at(-1)
    const call = tail?.content.parts[1] as { toolCallId: string }
    for (const turn of [
      { kind: "message", message_id: "u_cross", text: "Build it" },
      {
        kind: "results",
        message_id: tail?.id,
        results: [
          {
            kind: "answer",
            tool_call_id: call.toolCallId,
            output: { answer: "skipped" },
          },
        ],
      },
      {
        kind: "results",
        message_id: tail?.id,
        results: [
          { kind: "approval", approval_id: call.toolCallId, approved: true },
        ],
      },
    ]) {
      const stub = stubOrchestrator()
      const refused = await mine.call(stub, "/chat", {
        method: "POST",
        body: JSON.stringify({ conversation_id: theirId, mode: "act", turn }),
      })
      expect(refused.status, JSON.stringify(turn)).toBe(404)
      expect(ErrorEnvelope.parse(await refused.json()).code).toBe(
        "conversation.not_found"
      )
      expect(stub.calls).toHaveLength(0)
    }
    expect(await history(theirs, theirId)).toEqual(before)
  })
})

describe("another org's staff history is invisible", () => {
  /** Each org's hires, read as `as`, with `whose` named in the where clause. */
  const history = (as: Owner, whose: Owner) =>
    kit.withOrg({ orgId: as.orgId }, async (db) => [
      await db
        .select({ staffId: staffEvents.staffId })
        .from(staffEvents)
        .where(sql`${staffEvents.orgId} = ${whose.orgId}`),
      await db
        .select({ staffId: events.staffId })
        .from(events)
        .where(
          sql`${events.orgId} = ${whose.orgId} and ${events.type} = 'staff.hired'`
        ),
    ])

  it("control: the org reads its own three hires", async () => {
    const [rows, logged] = await history(mine, mine)
    expect(rows).toHaveLength(3)
    expect(logged).toHaveLength(3)
  })

  it("reads none of another org's hires, even by its id", async () => {
    const [rows, logged] = await history(theirs, mine)
    expect(rows).toEqual([])
    expect(logged).toEqual([])
  })
})

describe("another org's reminder is 404 and never changed", () => {
  const keyed = (method: string, body: unknown, key = crypto.randomUUID()) => ({
    method,
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  })
  const create = async (who: Owner, title: string, key?: string) =>
    Reminder.parse(
      await (
        await who.call(
          stubOrchestrator(),
          "/reminders",
          keyed("POST", { title, due_at: null }, key)
        )
      ).json()
    )
  const notes = async (who: Owner) =>
    WorkspaceStatus.parse(
      await (await who.call(stubOrchestrator(), "/workspace")).json()
    ).reminders.notes

  it("refuses to complete or reopen it, and never lists it", async () => {
    const theirReminder = await create(theirs, "Theirs (fixture)")
    for (const done of [true, false]) {
      const response = await mine.call(
        stubOrchestrator(),
        `/reminders/${theirReminder.id}`,
        keyed("PATCH", { done })
      )
      expect(response.status, String(done)).toBe(404)
      expect(ErrorEnvelope.parse(await response.json())).toMatchObject({
        code: "reminder.not_found",
        detail: {},
      })
    }
    expect((await notes(mine)).map((n) => n.id)).not.toContain(theirReminder.id)
    expect(await notes(theirs)).toContainEqual(theirReminder)
  })

  it("control: the org completes its own", async () => {
    const own = await create(mine, "Mine (fixture)")
    const response = await mine.call(
      stubOrchestrator(),
      `/reminders/${own.id}`,
      keyed("PATCH", { done: true })
    )
    expect(response.status).toBe(200)
    expect(Reminder.parse(await response.json()).done_at).not.toBeNull()
  })

  it("makes a new reminder for a key another org already used", async () => {
    const key = crypto.randomUUID()
    const theirReminder = await create(theirs, "Theirs, keyed", key)
    const mineReminder = await create(mine, "Mine, keyed", key)
    expect(mineReminder.id).not.toBe(theirReminder.id)
    expect(mineReminder.title).toBe("Mine, keyed")
  })
})
