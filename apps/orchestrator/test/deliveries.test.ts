import { readReplyToken } from "@workspace/contracts"
import {
  conversationMessages,
  conversations,
  deliveries,
  eq,
  sql,
} from "@workspace/db"
import { afterAll, describe, expect, it, vi } from "vitest"
import {
  type DeliveryMessage,
  deliver,
  deliveriesBatch,
  MAX_RETRIES,
  redriveDeliveries,
} from "../src/deliveries.ts"
import { freshOrg, kit } from "./fixture.ts"

/**
 * The outbox against a database, with the Queue and the mail binding stood
 * in for. Skipped without DATABASE_URL, like the publish suite.
 */

const url = process.env.DATABASE_URL
const text = ["Your reminder is due."]

function stubs() {
  const queue = {
    send: vi.fn(async () => undefined),
    sendBatch: vi.fn(async (_batch: { body: DeliveryMessage }[]) => undefined),
  }
  const send = vi.fn(async (_message: EmailMessageBuilder) => ({
    messageId: "m",
  }))
  return {
    queue,
    send,
    env: {
      DELIVERIES: queue as unknown as Queue<DeliveryMessage>,
      OWNER_MAIL: { send } as unknown as SendEmail,
      APP_ORIGIN: "https://app.example.invalid",
      REPLY_TOKEN_KEY: "k".repeat(32),
      REPLY_MAILBOX: "reply@reply.example.invalid",
      VAPID_SUBJECT: "mailto:ops@example.invalid",
      HYPERDRIVE: {} as Hyperdrive,
    },
  }
}

/** One Queue delivery of `body`; what the consumer did with it. */
async function consume(
  env: ReturnType<typeof stubs>["env"],
  body: DeliveryMessage,
  attempts = 1
) {
  const message = { body, attempts, ack: vi.fn(), retry: vi.fn() }
  await deliveriesBatch(
    { messages: [message] } as unknown as MessageBatch<DeliveryMessage>,
    env,
    kit
  )
  return message
}

const rowOf = async (orgId: string, key: string) => {
  const [row] = await kit.withOrg({ orgId }, (db) =>
    db.select().from(deliveries).where(eq(deliveries.key, key))
  )
  return row
}

const mail = (orgId: string, key: string): DeliveryMessage => ({
  orgId,
  key,
  channel: "email",
  subject: "A reminder",
  text: "Call the supplier.\n\nIt is due now & overdue <soon>.",
})

afterAll(() => kit.close())

describe.skipIf(!url)("the delivery outbox", () => {
  it("queues a key once and sends nothing for a repeat", async () => {
    const orgId = await freshOrg(kit)
    const { env, queue } = stubs()
    const body = mail(orgId, "reminder:r1")
    expect(await deliver(kit, env, body)).toBe("queued")
    expect(await deliver(kit, env, body)).toBe("exists")
    expect(queue.send).toHaveBeenCalledTimes(1)
    expect(await rowOf(orgId, "reminder:r1")).toMatchObject({
      state: "pending",
      attempts: 0,
    })
  })

  it("frees the key when the queue refuses the message", async () => {
    const orgId = await freshOrg(kit)
    const { env, queue } = stubs()
    queue.send.mockRejectedValueOnce(new Error("queue down"))
    await expect(deliver(kit, env, mail(orgId, "reminder:r2"))).rejects.toThrow(
      "queue down"
    )
    expect(await rowOf(orgId, "reminder:r2")).toBeUndefined()
    expect(await deliver(kit, env, mail(orgId, "reminder:r2"))).toBe("queued")
  })

  it("emails the owner with a link to the app and settles the row, once", async () => {
    const orgId = await freshOrg(kit)
    const { env, send } = stubs()
    const body = mail(orgId, "reminder:r3")
    await deliver(kit, env, body)
    const first = await consume(env, body)
    expect(first.ack).toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
    const sent = send.mock.calls[0]?.[0]
    expect(sent).toMatchObject({
      from: { name: "Reme", email: "hello@remeai.co.uk" },
      to: `probe-${orgId}@example.test`,
      subject: "A reminder",
    })
    expect(sent?.text).toContain("https://app.example.invalid/app")
    expect(sent?.html).toContain("overdue &#60;soon&#62;")
    expect(await rowOf(orgId, "reminder:r3")).toMatchObject({
      state: "sent",
      attempts: 1,
      error: null,
    })
    // The Queue redelivering a settled message sends nothing.
    const again = await consume(env, body)
    expect(again.ack).toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("sets a Reply-To that names the conversation, and none when no conversation is named", async () => {
    const orgId = await freshOrg(kit)
    const { env, send } = stubs()
    const conversationId = crypto.randomUUID()
    for (const body of [
      { ...mail(orgId, "reminder:t1"), conversationId },
      mail(orgId, "reminder:t2"),
    ]) {
      await deliver(kit, env, body)
      await consume(env, body)
    }
    const [withReply, without] = send.mock.calls.map((c) => c[0])
    const to = withReply?.replyTo as string
    expect(to).toMatch(/^reply\+[A-Za-z0-9_-]{56}@reply\.example\.invalid$/)
    expect(
      await readReplyToken(
        "k".repeat(32),
        to.slice("reply+".length, to.indexOf("@"))
      )
    ).toEqual({ orgId, conversationId })
    expect(without).not.toHaveProperty("replyTo")
  })

  it("turns the email channel off when the address is suppressed", async () => {
    const orgId = await freshOrg(kit)
    const { env, send } = stubs()
    send.mockRejectedValueOnce(
      Object.assign(new Error("suppressed"), { code: "E_RECIPIENT_SUPPRESSED" })
    )
    const first = mail(orgId, "reminder:s1")
    await deliver(kit, env, first)
    expect((await consume(env, first)).ack).toHaveBeenCalled()
    expect(await rowOf(orgId, "reminder:s1")).toMatchObject({
      state: "suppressed",
    })
    const next = mail(orgId, "reminder:s2")
    await deliver(kit, env, next)
    expect((await consume(env, next)).ack).toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
    expect(await rowOf(orgId, "reminder:s2")).toMatchObject({
      state: "suppressed",
    })
  })

  it("retries a transient error, then settles it as failed", async () => {
    const orgId = await freshOrg(kit)
    const { env, send } = stubs()
    send.mockRejectedValue(
      Object.assign(new Error("slow down"), { code: "E_RATE_LIMIT_EXCEEDED" })
    )
    const body = mail(orgId, "reminder:t1")
    await deliver(kit, env, body)
    const retried = await consume(env, body, 1)
    expect(retried.retry).toHaveBeenCalledWith({ delaySeconds: 30 })
    expect(retried.ack).not.toHaveBeenCalled()
    expect(await rowOf(orgId, "reminder:t1")).toMatchObject({
      state: "pending",
      attempts: 1,
    })
    const last = await consume(env, body, MAX_RETRIES + 1)
    expect(last.ack).toHaveBeenCalled()
    expect(await rowOf(orgId, "reminder:t1")).toMatchObject({
      state: "failed",
      error: "E_RATE_LIMIT_EXCEEDED",
    })
  })

  it("fails a permanent error at once, without retrying", async () => {
    const orgId = await freshOrg(kit)
    const { env, send } = stubs()
    send.mockRejectedValue(
      Object.assign(new Error("no"), { code: "E_SENDER_NOT_VERIFIED" })
    )
    const body = mail(orgId, "reminder:p1")
    await deliver(kit, env, body)
    const done = await consume(env, body)
    expect(done.ack).toHaveBeenCalled()
    expect(done.retry).not.toHaveBeenCalled()
    expect(await rowOf(orgId, "reminder:p1")).toMatchObject({
      state: "failed",
      error: "E_SENDER_NOT_VERIFIED",
    })
  })

  it("posts in-app to the named conversation, not the newest", async () => {
    const orgId = await freshOrg(kit)
    const { env } = stubs()
    const ids = await kit.withOrg({ orgId }, async (db) => {
      const [chief] = await db.execute<{ id: string }>(
        sql`select id from staff where staff_code = 'COS-001'`
      )
      const make = async (updatedAt: Date) => {
        const [row] = await db
          .insert(conversations)
          .values({
            orgId,
            kind: "assistant",
            createdByStaffId: chief?.id as string,
            updatedAt,
          })
          .returning({ id: conversations.id })
        return row?.id as string
      }
      return {
        older: await make(new Date(2026, 0, 1)),
        newest: await make(new Date(2026, 0, 3)),
      }
    })
    const body: DeliveryMessage = {
      orgId,
      key: "reminder:i1",
      channel: "in_app",
      message: { text },
      conversationId: ids.older,
    }
    await deliver(kit, env, body)
    expect((await consume(env, body)).ack).toHaveBeenCalled()
    const countIn = (id: string) =>
      kit.withOrg({ orgId }, (db) =>
        db
          .select({ id: conversationMessages.id })
          .from(conversationMessages)
          .where(eq(conversationMessages.conversationId, id))
      )
    expect(await countIn(ids.older)).toHaveLength(1)
    expect(await countIn(ids.newest)).toHaveLength(0)
    expect(await rowOf(orgId, "reminder:i1")).toMatchObject({ state: "sent" })
  })

  it("sends once when two consumers hold the same message", async () => {
    const orgId = await freshOrg(kit)
    const { env, send } = stubs()
    send.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
      return { messageId: "m" }
    })
    const body = mail(orgId, "reminder:c1")
    await deliver(kit, env, body)
    const [a, b] = await Promise.all([consume(env, body), consume(env, body)])
    expect(a.ack).toHaveBeenCalled()
    expect(b.ack).toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
    expect(await rowOf(orgId, "reminder:c1")).toMatchObject({
      state: "sent",
      attempts: 1,
      leaseUntil: null,
      payload: null,
    })
  })

  it("takes a sending row back only once its lease has lapsed", async () => {
    const orgId = await freshOrg(kit)
    const { env, send } = stubs()
    const body = mail(orgId, "reminder:l1")
    await deliver(kit, env, body)
    const lease = (interval: string) =>
      kit.withOrg({ orgId }, (db) =>
        db
          .update(deliveries)
          .set({
            state: "sending",
            leaseUntil: sql`now() + ${interval}::interval`,
          })
          .where(eq(deliveries.key, "reminder:l1"))
      )
    await lease("1 minute")
    expect((await consume(env, body)).ack).toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    await lease("-1 minute")
    await consume(env, body)
    expect(send).toHaveBeenCalledTimes(1)
    expect(await rowOf(orgId, "reminder:l1")).toMatchObject({ state: "sent" })
  })

  it("settles an email that may have left as unknown and never resends it", async () => {
    const orgId = await freshOrg(kit)
    const { env, send } = stubs()
    send.mockRejectedValue(new Error("connection reset"))
    const body = mail(orgId, "reminder:u1")
    await deliver(kit, env, body)
    const first = await consume(env, body)
    expect(first.ack).toHaveBeenCalled()
    expect(first.retry).not.toHaveBeenCalled()
    expect(await rowOf(orgId, "reminder:u1")).toMatchObject({
      state: "unknown",
      leaseUntil: null,
    })
    await consume(env, body)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("queues again what has sat unsettled for ten minutes, and nothing else", async () => {
    const orgId = await freshOrg(kit)
    const { env, queue } = stubs()
    const keys = {
      old: "reminder:d1",
      lapsed: "reminder:d2",
      held: "reminder:d3",
      fresh: "reminder:d4",
      done: "reminder:d5",
    }
    for (const key of Object.values(keys))
      await deliver(kit, env, mail(orgId, key))
    const set = (
      key: string,
      state: "pending" | "sending" | "sent",
      lease: string,
      age: string
    ) =>
      kit.withOrg({ orgId }, (db) =>
        db
          .update(deliveries)
          .set({
            state,
            leaseUntil: sql`now() + ${lease}::interval`,
            createdAt: sql`now() - ${age}::interval`,
          })
          .where(eq(deliveries.key, key))
      )
    await set(keys.old, "pending", "0", "11 minutes")
    await set(keys.lapsed, "sending", "-1 minute", "11 minutes")
    await set(keys.held, "sending", "1 minute", "11 minutes")
    await set(keys.fresh, "pending", "0", "1 minute")
    await set(keys.done, "sent", "0", "11 minutes")
    await kit.withOrg({ orgId }, (db) =>
      db
        .update(deliveries)
        .set({ payload: null })
        .where(eq(deliveries.key, keys.done))
    )
    expect(await redriveDeliveries(kit, env, orgId)).toBe(2)
    const queued = queue.sendBatch.mock.calls[0]?.[0].map((m) => m.body.key)
    expect(queued).toEqual([keys.old, keys.lapsed])
  })
})
