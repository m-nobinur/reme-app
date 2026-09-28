import {
  Conversation,
  ConversationHistory,
  ErrorEnvelope,
} from "@workspace/contracts"
import { type Tenancy, tenancy } from "@workspace/db"
import postgres from "postgres"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { appendMessages, type StoredMessage } from "../src/conversations.ts"
import { eventKey, TITLE_MAX, titleFrom } from "../src/http.ts"
import { type Owner, owner, stubOrchestrator } from "./owner-fixture.ts"
import { stubJwksFetch } from "./sealed-session.ts"

/**
 * The owner's thumbs on the CoS's replies, and a conversation's title from
 * its first message. Cross-org denial is in `tenancy/owner.test.ts`.
 */

describe("a title from the owner's first message", () => {
  it("keeps a short first line as it is, whitespace collapsed", () => {
    expect(titleFrom("  Weekend   prices\tplease  ")).toBe(
      "Weekend prices please"
    )
  })

  it("takes the first line only", () => {
    expect(titleFrom("Change the hero\nand the footer too")).toBe(
      "Change the hero"
    )
  })

  it("drops control characters and bidi controls", () => {
    expect(titleFrom("Pay\u0007ment ‮eludom‬ ⁦page⁩‏")).toBe("Pay ment eludom page")
  })

  it("cuts under 60 characters at a word boundary", () => {
    const words =
      "Please update the booking page so that Saturday mornings show as open slots"
    const title = titleFrom(words) as string
    expect([...title].length).toBeLessThanOrEqual(TITLE_MAX)
    expect(TITLE_MAX).toBeLessThan(60)
    expect(words.startsWith(title)).toBe(true)
    expect(words[title.length]).toBe(" ")
    expect(title).toBe(
      "Please update the booking page so that Saturday mornings"
    )
  })

  it("cuts one long word hard, and counts characters, not code units", () => {
    expect(titleFrom("x".repeat(80))).toBe("x".repeat(TITLE_MAX))
    const emoji = "🧽".repeat(70)
    expect([...(titleFrom(emoji) as string)].length).toBe(TITLE_MAX)
  })

  it("counts code points at the 59-character boundary", () => {
    const whole = `${"a".repeat(57)} \u{1F9FD}`
    expect([...whole].length).toBe(59)
    expect(titleFrom(whole)).toBe(whole)
    expect(titleFrom(`${whole}b`)).toBe("a".repeat(57))
    expect(titleFrom(`${"a".repeat(58)}\u{1F9FD}b`)).toBe(
      `${"a".repeat(58)}\u{1F9FD}`
    )
  })

  it("gives nothing for text with no words", () => {
    expect(titleFrom(" ‮\u0007 ")).toBeNull()
  })
})

describe("an event key from a client's key", () => {
  it("is a ULID's shape, the same for the same key, and scoped", async () => {
    const a = await eventKey("cos.feedback", "press-1")
    expect(a).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
    expect(await eventKey("cos.feedback", "press-1")).toBe(a)
    expect(await eventKey("cos.feedback", "press-2")).not.toBe(a)
    expect(await eventKey("other", "press-1")).not.toBe(a)
  })
})

const url = process.env.DATABASE_URL

describe.skipIf(!url)(
  "POST /conversations/:id/feedback, on a live connection",
  () => {
    const kit: Tenancy = tenancy(url as string, { max: 2 })
    const admin = postgres(url as string, { max: 1 })
    let realFetch: typeof fetch
    let me: Owner

    beforeAll(async () => {
      realFetch = globalThis.fetch
      globalThis.fetch = stubJwksFetch()
      me = await owner(kit, url as string, "feedback")
    }, 60_000)

    afterAll(async () => {
      globalThis.fetch = realFetch
      await admin.end()
      await kit.close()
    })

    const keyed = (
      method: string,
      body?: unknown,
      key = crypto.randomUUID()
    ) => ({
      method,
      headers: { "content-type": "application/json", "idempotency-key": key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    const call = (path: string, init?: RequestInit) =>
      me.call(stubOrchestrator(), path, init)

    const message = (
      id: string,
      role: "user" | "assistant",
      parent: string | null,
      parts: StoredMessage["content"]["parts"]
    ): StoredMessage => ({
      id,
      parent_id: parent,
      format: "ai-sdk/v6",
      content: { role, parts },
    })

    /** A conversation holding an owner's message, a reply, and a card with no text. */
    async function thread() {
      const made = await call("/conversations", keyed("POST"))
      const { id } = Conversation.parse(await made.json())
      const refused = await appendMessages(kit, me.orgId, id, [
        message("u1", "user", null, [{ type: "text", text: "Hi" }]),
        message("a1", "assistant", "u1", [
          { type: "step-start" },
          { type: "text", text: "Hello, how can I help?", state: "done" },
        ]),
        message("a2", "assistant", "a1", [
          { type: "step-start" },
          {
            type: "tool-request_change",
            toolCallId: "call_1",
            state: "approval-requested",
            input: { text: "Add a slot." },
            approval: { id: "ap1" },
          },
        ]),
      ])
      expect(refused).toBeNull()
      return id
    }

    const rate = (
      id: string,
      messageId: string,
      rating: "up" | "down",
      key?: string
    ) =>
      call(
        `/conversations/${id}/feedback`,
        keyed("POST", { message_id: messageId, rating }, key)
      )

    const ratings = async (id: string) => {
      const read = await call(`/conversations/${id}/messages`)
      const { messages } = ConversationHistory.parse(await read.json())
      return Object.fromEntries(messages.map((m) => [m.id, m.feedback]))
    }

    const feedbackEvents = (id: string) =>
      admin<
        {
          session_id: string | null
          seq: number | null
          payload: { rating: string }
        }[]
      >`
      select session_id, seq, payload from events
      where type = 'cos.feedback' and payload->>'conversation_id' = ${id}
      order by recorded_at`

    it("keeps the latest rating: up, down, up reads as up", async () => {
      const id = await thread()
      for (const rating of ["up", "down", "up"] as const) {
        const done = await rate(id, "a1", rating)
        expect(done.status).toBe(204)
      }
      expect(await ratings(id)).toEqual({ u1: null, a1: "up", a2: null })
      const logged = await feedbackEvents(id)
      expect(logged.map((e) => e.payload.rating)).toEqual(["up", "down", "up"])
      // No session and no seq: the history derivation never reads it.
      expect(logged.every((e) => e.session_id === null && e.seq === null)).toBe(
        true
      )
    })

    it("reads down after up, down", async () => {
      const id = await thread()
      await rate(id, "a1", "up")
      await rate(id, "a1", "down")
      expect((await ratings(id)).a1).toBe("down")
    })

    it("shows no rating on an owner's message, whatever the log holds", async () => {
      const id = await thread()
      // Only a direct write could rate a user row: the route refuses it.
      await admin`
      insert into events (event_id, org_id, type, occurred_at, idempotency_key, payload)
      values (${await eventKey("probe", crypto.randomUUID())}, ${me.orgId}, 'cos.feedback', now(),
        ${await eventKey("probe", crypto.randomUUID())},
        ${admin.json({ conversation_id: id, message_id: "u1", rating: "up" })})`
      expect((await ratings(id)).u1).toBeNull()
    })

    it("treats a replayed key as the same press", async () => {
      const id = await thread()
      const key = crypto.randomUUID()
      expect((await rate(id, "a1", "up", key)).status).toBe(204)
      expect((await rate(id, "a1", "up", key)).status).toBe(204)
      // Even with another body, the key names the press already recorded.
      expect((await rate(id, "a1", "down", key)).status).toBe(204)
      expect((await feedbackEvents(id)).length).toBe(1)
      expect((await ratings(id)).a1).toBe("up")
    })

    it.each([
      ["the owner's own message", "u1"],
      ["a reply with no text", "a2"],
      ["a message it does not hold", "nope"],
    ])("answers 404 for %s, and records nothing", async (_name, messageId) => {
      const id = await thread()
      const done = await rate(id, messageId, "up")
      expect(done.status).toBe(404)
      expect(ErrorEnvelope.parse(await done.json()).code).toBe(
        "message.not_found"
      )
      expect(await feedbackEvents(id)).toEqual([])
    })

    it("answers 404 for another conversation's reply", async () => {
      const id = await thread()
      const other = Conversation.parse(
        await (await call("/conversations", keyed("POST"))).json()
      ).id
      expect(
        await appendMessages(kit, me.orgId, other, [
          message("ou", "user", null, [{ type: "text", text: "Hi" }]),
          message("ob", "assistant", "ou", [
            { type: "text", text: "Hello.", state: "done" },
          ]),
        ])
      ).toBeNull()
      const done = await rate(id, "ob", "up")
      expect(done.status).toBe(404)
      expect(ErrorEnvelope.parse(await done.json()).code).toBe(
        "message.not_found"
      )
      expect(await feedbackEvents(id)).toEqual([])
      expect(await feedbackEvents(other)).toEqual([])
    })

    it("answers 404 for a conversation the org does not hold", async () => {
      const done = await rate(crypto.randomUUID(), "a1", "up")
      expect(done.status).toBe(404)
      expect(ErrorEnvelope.parse(await done.json()).code).toBe(
        "conversation.not_found"
      )
    })

    it("wants an Idempotency-Key", async () => {
      const id = await thread()
      const done = await call(`/conversations/${id}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message_id: "a1", rating: "up" }),
      })
      expect(done.status).toBe(400)
    })

    it("never waits on a turn: a held turn lock does not delay it", async () => {
      const id = await thread()
      await admin.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(2, hashtext(${id}::text))`
        const started = Date.now()
        const done = await rate(id, "a1", "down")
        expect(done.status).toBe(204)
        expect(Date.now() - started).toBeLessThan(2_000)
      })
    })

    it("names a conversation from its first message, and leaves a rename alone", async () => {
      const send = (id: string, text: string) =>
        call("/chat", {
          method: "POST",
          body: JSON.stringify({
            conversation_id: id,
            mode: "ask",
            turn: {
              kind: "message",
              message_id: `m-${crypto.randomUUID()}`,
              text,
            },
          }),
        })
      const titleOf = async (id: string) =>
        Conversation.parse(await (await call(`/conversations/${id}`)).json())
          .title

      const fresh = Conversation.parse(
        await (await call("/conversations", keyed("POST"))).json()
      ).id
      expect((await send(fresh, "Weekend prices\nfor the summer")).status).toBe(
        200
      )
      expect(await titleOf(fresh)).toBe("Weekend prices")
      // A later message does not rename it.
      expect((await send(fresh, "Something else")).status).toBe(200)
      expect(await titleOf(fresh)).toBe("Weekend prices")

      const renamed = Conversation.parse(
        await (await call("/conversations", keyed("POST"))).json()
      ).id
      await call(
        `/conversations/${renamed}`,
        keyed("PATCH", { title: "My name" })
      )
      expect((await send(renamed, "Weekend prices")).status).toBe(200)
      expect(await titleOf(renamed)).toBe("My name")
    })

    const sendTo = (id: string, text: string) =>
      call("/chat", {
        method: "POST",
        body: JSON.stringify({
          conversation_id: id,
          mode: "ask",
          turn: {
            kind: "message",
            message_id: `m-${crypto.randomUUID()}`,
            text,
          },
        }),
      })
    const titleOf = async (id: string) =>
      Conversation.parse(await (await call(`/conversations/${id}`)).json())
        .title

    it("leaves the onboarding conversation untitled", async () => {
      const list = (await (await call("/conversations")).json()) as {
        conversations: { id: string; kind: string }[]
      }
      const onboarding = list.conversations.find((c) => c.kind === "onboarding")
      expect(onboarding).toBeDefined()
      const id = onboarding?.id as string
      // With its first row gone, so only its kind keeps it untitled.
      await admin`delete from conversation_messages where conversation_id = ${id}`
      expect((await sendTo(id, "Hello there")).status).toBe(200)
      expect(await titleOf(id)).toBeNull()
    })

    it("leaves a thread that already held messages untitled", async () => {
      const id = Conversation.parse(
        await (await call("/conversations", keyed("POST"))).json()
      ).id
      const earlier: StoredMessage[] = Array.from({ length: 40 }, (_, i) =>
        message(
          `old_${i}`,
          i % 2 ? "assistant" : "user",
          i ? `old_${i - 1}` : null,
          [{ type: "text", text: `Message ${i}` }]
        )
      )
      expect(await appendMessages(kit, me.orgId, id, earlier)).toBeNull()
      expect((await sendTo(id, "ok thanks")).status).toBe(200)
      expect(await titleOf(id)).toBeNull()
    })

    it("names nothing when a turn is refused, and names it on the next one", async () => {
      const id = Conversation.parse(
        await (await call("/conversations", keyed("POST"))).json()
      ).id
      await admin.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(2, hashtext(${id}::text))`
        const refused = await sendTo(id, "Refused words")
        expect(refused.status).toBe(409)
      })
      expect(await titleOf(id)).toBeNull()
      expect((await sendTo(id, "Accepted words")).status).toBe(200)
      expect(await titleOf(id)).toBe("Accepted words")
    })
  }
)
