import {
  Conversation,
  ConversationHistory,
  ConversationList,
  ErrorEnvelope,
} from "@workspace/contracts"
import {
  conversationMessages,
  conversations,
  eq,
  sql,
  staff,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { appendMessages, type StoredMessage } from "../src/conversations.ts"
import { BODY_MAX } from "../src/http.ts"
import worker from "../src/index.ts"
import { type Owner, owner, stubOrchestrator } from "./owner-fixture.ts"
import { env, stubJwksFetch } from "./sealed-session.ts"

/**
 * The conversation routes on a live connection. Cross-org denial is in
 * `tenancy/owner.test.ts`, inside the blocking gate.
 */

const url = process.env.DATABASE_URL

const keyed = (method: string, body?: unknown, key = crypto.randomUUID()) => ({
  method,
  headers: { "content-type": "application/json", "idempotency-key": key },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})

const text = (id: string, role: "user" | "assistant", parent: string | null) =>
  ({
    id,
    parent_id: parent,
    format: "ai-sdk/v6",
    content: { role, parts: [{ type: "text", text: `${role} says hello` }] },
  }) satisfies StoredMessage

describe.skipIf(!url)("the conversation routes, on a live connection", () => {
  const kit: Tenancy = tenancy(url as string, { max: 2 })
  let realFetch: typeof fetch
  let who: Owner

  const call = (path: string, init: RequestInit = {}) =>
    who.call(stubOrchestrator(), path, init)

  const create = async (key = crypto.randomUUID()) => {
    const response = await call("/conversations", keyed("POST", undefined, key))
    return { response, body: Conversation.parse(await response.json()) }
  }

  beforeAll(async () => {
    realFetch = globalThis.fetch
    globalThis.fetch = stubJwksFetch()
    who = await owner(kit, url as string, "talker")
  }, 60_000)

  afterAll(async () => {
    globalThis.fetch = realFetch
    await kit.close()
  })

  it("creates an assistant conversation, and a retried key returns it", async () => {
    const key = "__LOCALID_probe1"
    const first = await create(key)
    expect(first.response.status).toBe(201)
    expect(first.body).toMatchObject({
      kind: "assistant",
      title: null,
      archived_at: null,
    })
    const again = await create(key)
    expect(again.response.status).toBe(201)
    expect(again.body).toEqual(first.body)
  })

  it("refuses an idempotency key longer than 255 characters", async () => {
    const response = await call(
      "/conversations",
      keyed("POST", undefined, "k".repeat(256))
    )
    expect(response.status).toBe(400)
    expect(ErrorEnvelope.parse(await response.json()).code).toBe(
      "idempotency_key.missing"
    )
  })

  it("needs an idempotency key to create or change one", async () => {
    const { body } = await create()
    for (const [path, method] of [
      ["/conversations", "POST"],
      [`/conversations/${body.id}`, "PATCH"],
    ]) {
      const response = await call(path as string, {
        method,
        body: JSON.stringify({ title: "x" }),
      })
      expect(response.status, method).toBe(400)
      expect(ErrorEnvelope.parse(await response.json()).code).toBe(
        "idempotency_key.missing"
      )
    }
  })

  it("fetches one by id, and answers an unknown or malformed id with 404", async () => {
    const { body } = await create()
    const found = await call(`/conversations/${body.id}`)
    expect(Conversation.parse(await found.json())).toEqual(body)
    for (const id of [crypto.randomUUID(), "not-a-uuid"]) {
      for (const path of [
        `/conversations/${id}`,
        `/conversations/${id}/messages`,
      ]) {
        const response = await call(path)
        expect(response.status, path).toBe(404)
        expect(ErrorEnvelope.parse(await response.json()).code).toBe(
          "conversation.not_found"
        )
      }
    }
  })

  it("renames with the title's spaces collapsed, and a retry changes nothing", async () => {
    const { body } = await create()
    const key = crypto.randomUUID()
    const renamed = Conversation.parse(
      await (
        await call(
          `/conversations/${body.id}`,
          keyed("PATCH", { title: "  Weekend \n  prices  " }, key)
        )
      ).json()
    )
    expect(renamed.title).toBe("Weekend prices")
    const again = Conversation.parse(
      await (
        await call(
          `/conversations/${body.id}`,
          keyed("PATCH", { title: "  Weekend \n  prices  " }, key)
        )
      ).json()
    )
    expect(again).toEqual(renamed)
  })

  it("archives once, keeps the first time on a retry, and unarchives", async () => {
    const { body } = await create()
    const patch = async (archived: boolean) =>
      Conversation.parse(
        await (
          await call(`/conversations/${body.id}`, keyed("PATCH", { archived }))
        ).json()
      )
    const first = await patch(true)
    expect(first.archived_at).not.toBeNull()
    expect((await patch(true)).archived_at).toBe(first.archived_at)
    const back = await patch(false)
    expect(back.archived_at).toBeNull()
    // Archiving old threads must not push active ones off the list.
    expect(first.updated_at).toBe(body.updated_at)
    expect(back.updated_at).toBe(body.updated_at)
  })

  it("moves a renamed conversation up the list", async () => {
    const { body } = await create()
    await create()
    const renamed = Conversation.parse(
      await (
        await call(`/conversations/${body.id}`, keyed("PATCH", { title: "Up" }))
      ).json()
    )
    expect(renamed.updated_at > body.updated_at).toBe(true)
    const list = ConversationList.parse(
      await (await call("/conversations")).json()
    )
    expect(list.conversations[0]?.id).toBe(body.id)
  })

  it("refuses a patch the contract refuses", async () => {
    const { body } = await create()
    for (const patch of [
      {},
      { title: "x", archived: true },
      { title: "  " },
      // Postgres refuses NUL in text, so it is a 400 here and never a 500.
      { title: "a\u0000b" },
    ]) {
      const response = await call(
        `/conversations/${body.id}`,
        keyed("PATCH", patch)
      )
      expect(response.status, JSON.stringify(patch)).toBe(400)
      expect(ErrorEnvelope.parse(await response.json()).code).toBe(
        "request.invalid"
      )
    }
  })

  it("refuses a body over the cap with 413, before reading it all", async () => {
    const { body } = await create()
    const big = JSON.stringify({ title: "a".repeat(BODY_MAX) })
    const declared = await call(`/conversations/${body.id}`, {
      ...keyed("PATCH"),
      body: big,
    })
    expect(declared.status).toBe(413)
    expect(ErrorEnvelope.parse(await declared.json()).code).toBe(
      "request.too_large"
    )
    // Streamed, so no content-length says how big it is.
    const streamed = await call(`/conversations/${body.id}`, {
      ...keyed("PATCH"),
      body: new Blob([big]).stream(),
      duplex: "half",
    } as RequestInit)
    expect(streamed.status).toBe(413)
  })

  it("answers an unauthenticated oversized post with 401, without reading it", async () => {
    const request = new Request("http://api.invalid/conversations", {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: new Blob(["a".repeat(BODY_MAX * 2)]).stream(),
      duplex: "half",
    } as RequestInit)
    const response = await worker.fetch(request, env(url as string), {
      waitUntil: (promise: Promise<unknown>) => void promise.catch(() => null),
    } as unknown as ExecutionContext)
    expect(response.status).toBe(401)
    expect(request.bodyUsed).toBe(false)
  })

  it("lets an impersonated session do nothing but read", async () => {
    const { body } = await create()
    const impersonated = {
      cookie: { impersonator: { email: "admin@probe.invalid", reason: null } },
    }
    for (const [path, method] of [
      [`/conversations/${body.id}`, "PATCH"],
      ["/conversations", "POST"],
      [`/conversations/${body.id}`, "DELETE"],
      ["/conversations", "PUT"],
    ] as const) {
      const response = await who.call(stubOrchestrator(), path, {
        ...keyed(method, { title: "x" }),
        ...impersonated,
      })
      expect(response.status, method).toBe(403)
    }
  })

  it("lists 50 at most, newest first", async () => {
    const made = await kit.withOrg({ orgId: who.orgId }, async (db) => {
      const [creator] = await db
        .select({ by: staff.id })
        .from(staff)
        .where(eq(staff.staffCode, "OWN-001"))
      const base = Date.now() - 3_600_000
      return db
        .insert(conversations)
        .values(
          Array.from({ length: 51 }, (_, i) => ({
            orgId: who.orgId,
            kind: "assistant" as const,
            createdByStaffId: creator?.by as string,
            updatedAt: new Date(base + i * 1000),
          }))
        )
        .returning({ id: conversations.id })
    })
    const newest = (await create()).body
    const list = ConversationList.parse(
      await (await call("/conversations")).json()
    )
    expect(list.conversations).toHaveLength(50)
    expect(list.conversations[0]?.id).toBe(newest.id)
    const times = list.conversations.map((c) => c.updated_at)
    expect(times).toEqual([...times].sort().reverse())
    expect(list.conversations.map((c) => c.id)).not.toContain(made[0]?.id)
  })

  describe("messages", () => {
    it("reads a turn back in the order it was written, dated from created_at", async () => {
      const { body } = await create()
      const turn = [text("u_1", "user", null), text("a_1", "assistant", "u_1")]
      expect(await appendMessages(kit, who.orgId, body.id, turn)).toBeNull()
      const rows = await kit.withOrg({ orgId: who.orgId }, (db) =>
        db
          .select({
            id: conversationMessages.id,
            createdAt: conversationMessages.createdAt,
            content: conversationMessages.content,
          })
          .from(conversationMessages)
          .where(eq(conversationMessages.conversationId, body.id))
      )
      const at = Object.fromEntries(rows.map((r) => [r.id, r.createdAt]))
      for (const row of rows) {
        expect(row.content).not.toHaveProperty("metadata")
      }

      const history = ConversationHistory.parse(
        await (await call(`/conversations/${body.id}/messages`)).json()
      )
      expect(history.messages.map((m) => m.id)).toEqual(["u_1", "a_1"])
      expect(
        history.messages.map((m) => m.content.metadata.custom.createdAt)
      ).toEqual([at.u_1?.toISOString(), at.a_1?.toISOString()])
    })

    it("reads by write order, not by created_at", async () => {
      const { body } = await create()
      await appendMessages(kit, who.orgId, body.id, [
        text("u_1", "user", null),
        text("a_1", "assistant", "u_1"),
      ])
      await appendMessages(kit, who.orgId, body.id, [
        text("u_2", "user", "a_1"),
        text("a_2", "assistant", "u_2"),
      ])
      // The first turn dated after the second: created_at order, id order
      // and the table's physical order all disagree with the write order.
      await kit.withOrg({ orgId: who.orgId }, (db) =>
        db
          .update(conversationMessages)
          .set({ createdAt: new Date(Date.now() + 3_600_000) })
          .where(
            sql`${conversationMessages.conversationId} = ${body.id} and ${conversationMessages.id} in ('u_1', 'a_1')`
          )
      )
      const history = ConversationHistory.parse(
        await (await call(`/conversations/${body.id}/messages`)).json()
      )
      expect(history.messages.map((m) => m.id)).toEqual([
        "u_1",
        "a_1",
        "u_2",
        "a_2",
      ])
    })

    it("refuses a message that is its own parent", async () => {
      const { body } = await create()
      const refused = (await appendMessages(kit, who.orgId, body.id, [
        text("self_1", "user", "self_1"),
      ])) as Response
      expect(refused.status).toBe(400)
      expect(ErrorEnvelope.parse(await refused.json()).code).toBe(
        "message.invalid"
      )
    })

    it("moves the conversation up the list when a turn is written", async () => {
      const { body } = await create()
      await create()
      await appendMessages(kit, who.orgId, body.id, [text("u_1", "user", null)])
      const list = ConversationList.parse(
        await (await call("/conversations")).json()
      )
      expect(list.conversations[0]?.id).toBe(body.id)
    })

    /**
     * A Worker's clock that has drifted a minute behind the database's, as a
     * Worker's and Neon's clocks can. Only `Date` is faked, so the driver's
     * timers run as usual.
     */
    const workerBehind = () => {
      vi.useFakeTimers({ toFake: ["Date"] })
      vi.setSystemTime(Date.now() - 60_000)
      return () => vi.useRealTimers()
    }

    it("moves a written conversation above one made before it, on the database's clock", async () => {
      const { body } = await create()
      await create()
      const restore = workerBehind()
      try {
        await appendMessages(kit, who.orgId, body.id, [
          text("u_1", "user", null),
        ])
      } finally {
        restore()
      }
      const list = ConversationList.parse(
        await (await call("/conversations")).json()
      )
      expect(list.conversations[0]?.id).toBe(body.id)
    })

    it("moves a conversation with a new chat turn up the list, on the database's clock", async () => {
      const { body } = await create()
      await create()
      const restore = workerBehind()
      try {
        const sent = await call("/chat", {
          method: "POST",
          body: JSON.stringify({
            conversation_id: body.id,
            mode: "ask",
            turn: { kind: "message", message_id: "u_chat", text: "Hello" },
          }),
        })
        expect(sent.status).toBe(200)
        await sent.text()
      } finally {
        restore()
      }
      const list = ConversationList.parse(
        await (await call("/conversations")).json()
      )
      expect(list.conversations[0]?.id).toBe(body.id)
    })

    it("moves a renamed conversation up the list, on the database's clock", async () => {
      const { body } = await create()
      await create()
      const restore = workerBehind()
      try {
        const renamed = await call(
          `/conversations/${body.id}`,
          keyed("PATCH", { title: "Renamed" })
        )
        expect(renamed.status).toBe(200)
      } finally {
        restore()
      }
      const list = ConversationList.parse(
        await (await call("/conversations")).json()
      )
      expect(list.conversations[0]?.id).toBe(body.id)
    })

    // Ordered by one clock: the retry wrote nothing, so the conversation made
    // after the turn's first write stays on top.
    it("writes nothing twice when a turn is retried, and leaves the list as it was", async () => {
      const { body } = await create()
      const turn = [text("u_1", "user", null), text("a_1", "assistant", "u_1")]
      await appendMessages(kit, who.orgId, body.id, turn)
      const newer = (await create()).body
      expect(await appendMessages(kit, who.orgId, body.id, turn)).toBeNull()
      const list = ConversationList.parse(
        await (await call("/conversations")).json()
      )
      expect(list.conversations[0]?.id).toBe(newer.id)
      const history = ConversationHistory.parse(
        await (await call(`/conversations/${body.id}/messages`)).json()
      )
      expect(history.messages).toHaveLength(2)
    })

    it("refuses a parent it never stored, as a validation error, and writes none of the turn", async () => {
      const { body } = await create()
      const refused = (await appendMessages(kit, who.orgId, body.id, [
        // The owner's message is fine and is written first; the reply names
        // a parent nobody stored. The owner's row must not survive it.
        text("u_1", "user", null),
        text("a_1", "assistant", "lost_after_a_failed_stream"),
      ])) as Response
      expect(refused.status).toBe(400)
      const envelope = ErrorEnvelope.parse(await refused.json())
      expect(envelope).toMatchObject({
        class: "validation",
        code: "message.parent_unknown",
        detail: {},
      })
      const history = ConversationHistory.parse(
        await (await call(`/conversations/${body.id}/messages`)).json()
      )
      expect(history.messages).toEqual([])
    })

    it("refuses a message the contract refuses, and writes none of the turn", async () => {
      const { body } = await create()
      const good = text("u_1", "user", null)
      const bad = [
        { ...good, content: { role: "system", parts: good.content.parts } },
        { ...good, content: { role: "user", parts: [] } },
        { ...good, content: { role: "user", parts: [{ text: "no type" }] } },
        { ...good, id: "has space" },
        { ...good, format: "aui/v0" },
        // The contract allows it; the table's check refuses a row that is
        // its own parent.
        { ...good, parent_id: "u_1" },
      ]
      for (const message of bad) {
        const refused = (await appendMessages(kit, who.orgId, body.id, [
          good,
          message as StoredMessage,
        ])) as Response
        expect(refused.status, JSON.stringify(message)).toBe(400)
        expect(ErrorEnvelope.parse(await refused.json())).toMatchObject({
          code: "message.invalid",
          detail: {},
        })
      }
      const history = ConversationHistory.parse(
        await (await call(`/conversations/${body.id}/messages`)).json()
      )
      expect(history.messages).toEqual([])
    })

    it("refuses NUL in a message, which Postgres cannot store", async () => {
      const { body } = await create()
      const message = text("u_1", "user", null)
      const refused = (await appendMessages(kit, who.orgId, body.id, [
        {
          ...message,
          content: {
            role: "user",
            parts: [{ type: "text", text: "a\u0000b" }],
          },
        },
      ])) as Response
      expect(refused.status).toBe(400)
      expect(ErrorEnvelope.parse(await refused.json()).code).toBe(
        "message.invalid"
      )
    })

    it("answers 404 for a conversation it does not hold, and writes nothing", async () => {
      const refused = (await appendMessages(
        kit,
        who.orgId,
        crypto.randomUUID(),
        [text("u_1", "user", null)]
      )) as Response
      expect(refused.status).toBe(404)
      expect(ErrorEnvelope.parse(await refused.json()).code).toBe(
        "conversation.not_found"
      )
    })
  })
})
