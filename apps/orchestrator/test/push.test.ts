import {
  addPushSubscription,
  conversations,
  deliveries,
  eq,
  pushSubscriptions,
  sql,
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
  type DeliveryMessage,
  deliver,
  deliveriesBatch,
} from "../src/deliveries.ts"
import { notification, type PushDelivery } from "../src/push.ts"
import { freshOrg, kit } from "./fixture.ts"

/**
 * The push channel against a database, with the Queue, the mail binding and
 * the push service stood in for. Keys are made here, never real ones.
 */

const url = process.env.DATABASE_URL

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url")
let vapidKey = ""
const endpoint = () =>
  `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair
  vapidKey = JSON.stringify(
    await crypto.subtle.exportKey("jwk", pair.privateKey)
  )
})

/** A browser's keys: an uncompressed P-256 point and a 16-byte secret. */
async function browser() {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  )) as CryptoKeyPair
  const raw = (await crypto.subtle.exportKey(
    "raw",
    pair.publicKey
  )) as ArrayBuffer
  return {
    p256dh: b64(new Uint8Array(raw)),
    auth: b64(crypto.getRandomValues(new Uint8Array(16))),
  }
}

function stubs() {
  const queue = {
    send: vi.fn(async (_message: DeliveryMessage) => undefined),
    sendBatch: vi.fn(async () => undefined),
  }
  return {
    queue,
    env: {
      DELIVERIES: queue as unknown as Queue<DeliveryMessage>,
      OWNER_MAIL: { send: vi.fn() } as unknown as SendEmail,
      APP_ORIGIN: "https://app.example.invalid",
      REPLY_MAILBOX: "reply@reply.example.invalid",
      HYPERDRIVE: {} as Hyperdrive,
      VAPID_PRIVATE_KEY: vapidKey,
      VAPID_SUBJECT: "mailto:ops@example.invalid",
    },
  }
}

async function consume(
  env: ReturnType<typeof stubs>["env"],
  body: DeliveryMessage
) {
  const message = { body, attempts: 1, ack: vi.fn(), retry: vi.fn() }
  await deliveriesBatch(
    { messages: [message] } as unknown as MessageBatch<DeliveryMessage>,
    env,
    kit
  )
  return message
}

/** An org with a conversation and `count` subscribed browsers. */
async function owner(count = 1) {
  const orgId = await freshOrg(kit)
  const { conversationId, staffId } = await kit.withOrg(
    { orgId },
    async (db) => {
      const [chief] = await db.execute<{ id: string }>(
        sql`select id from staff where staff_code = 'COS-001'`
      )
      const [conversation] = await db
        .insert(conversations)
        .values({
          orgId,
          kind: "assistant",
          createdByStaffId: chief?.id as string,
        })
        .returning({ id: conversations.id })
      return {
        conversationId: conversation?.id as string,
        staffId: chief?.id as string,
      }
    }
  )
  const endpoints: string[] = []
  for (let i = 0; i < count; i++) {
    const keys = await browser()
    endpoints.push(endpoint())
    await kit.withOrg({ orgId }, (db) =>
      addPushSubscription(db, {
        orgId,
        staffId,
        endpoint: endpoints.at(-1) as string,
        ...keys,
      })
    )
  }
  return { orgId, conversationId, endpoints }
}

const inApp = (
  orgId: string,
  key: string,
  conversationId: string,
  text = "Your homepage is ready to approve."
): DeliveryMessage => ({
  orgId,
  key,
  channel: "in_app",
  message: { text: [text] },
  conversationId,
})

/** The push an in-app delivery queued: the second thing sent to the Queue. */
const queuedPush = (queue: ReturnType<typeof stubs>["queue"]) =>
  queue.send.mock.calls.map((c) => c[0]).filter((m) => m.channel === "push")

const fetchMock = vi.fn(
  async (_url: string, _init: RequestInit) =>
    new Response(null, { status: 201 })
)

afterEach(() => {
  fetchMock.mockClear()
  fetchMock.mockImplementation(async () => new Response(null, { status: 201 }))
  vi.unstubAllGlobals()
})
afterAll(() => kit.close())

const rowOf = async (orgId: string, key: string) => {
  const [row] = await kit.withOrg({ orgId }, (db) =>
    db.select().from(deliveries).where(eq(deliveries.key, key))
  )
  return row
}

describe.skipIf(!url)("web push to the owner", () => {
  it("pushes an approval under a tag for its conversation, and sends it with a 6 hour TTL", async () => {
    vi.stubGlobal("fetch", fetchMock)
    const { orgId, conversationId, endpoints } = await owner()
    const { env, queue } = stubs()
    const body = inApp(orgId, "approval:a1", conversationId)
    await deliver(kit, env, body)
    await consume(env, body)

    const [push] = queuedPush(queue) as (PushDelivery & {
      orgId: string
      key: string
    })[]
    expect(push).toMatchObject({
      key: "approval:a1:push",
      kind: "approval",
      ttl: 6 * 3600,
      conversationId,
    })
    expect(notification(push as PushDelivery, conversationId)).toMatchObject({
      tag: `approval:${conversationId}`,
      renotify: true,
      url: `/app/c/${conversationId}`,
    })

    await deliver(kit, env, push as DeliveryMessage)
    const sent = await consume(env, push as DeliveryMessage)
    expect(sent.ack).toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [to, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(to).toBe(endpoints[0])
    expect(new Headers(init.headers).get("ttl")).toBe(String(6 * 3600))
    expect(await rowOf(orgId, "approval:a1:push")).toMatchObject({
      state: "sent",
      payload: null,
    })
  })

  it("keeps a reminder for a day and caps the body", async () => {
    const { orgId, conversationId } = await owner()
    const { env, queue } = stubs()
    const body = inApp(orgId, "reminder:r1", conversationId, "x".repeat(900))
    await deliver(kit, env, body)
    await consume(env, body)
    const [push] = queuedPush(queue) as unknown as PushDelivery[]
    expect(push).toMatchObject({ kind: "reminder", ttl: 24 * 3600 })
    expect(push?.body).toHaveLength(240)
    expect(push?.title.length).toBeLessThanOrEqual(120)
  })

  it("pushes a background message once, however often it is delivered", async () => {
    const { orgId, conversationId } = await owner()
    const { env, queue } = stubs()
    const body = inApp(orgId, "heartbeat:o:j:1", conversationId)
    await deliver(kit, env, body)
    await consume(env, body)
    // The Queue redelivers the settled message, and the sweep may too.
    await consume(env, body)
    await consume(env, body)
    expect(queuedPush(queue)).toHaveLength(1)
  })

  it("never pushes a quiet pass, nor anything to an owner with no browser", async () => {
    const quiet = await owner()
    const { env, queue } = stubs()
    const pass = inApp(
      quiet.orgId,
      "heartbeat:o:j:2",
      quiet.conversationId,
      "[quiet] nothing new"
    )
    await deliver(kit, env, pass)
    await consume(env, pass)
    const bare = await owner(0)
    const note = inApp(bare.orgId, "heartbeat:o:j:3", bare.conversationId)
    await deliver(kit, env, note)
    await consume(env, note)
    expect(queuedPush(queue)).toHaveLength(0)
  })

  it("drops a subscription on its first 404 or 410, and keeps the others", async () => {
    vi.stubGlobal("fetch", fetchMock)
    const { orgId, conversationId, endpoints } = await owner(3)
    const { env } = stubs()
    fetchMock.mockImplementation(async (to: string) => {
      if (to === endpoints[0]) return new Response(null, { status: 410 })
      if (to === endpoints[1]) return new Response(null, { status: 404 })
      return new Response(null, { status: 201 })
    })
    const push: DeliveryMessage = {
      orgId,
      key: "heartbeat:o:j:4:push",
      channel: "push",
      kind: "heartbeat",
      title: "Your assistant",
      body: "Something to see.",
      ttl: 6 * 3600,
      conversationId,
    }
    await deliver(kit, env, push)
    await consume(env, push)
    const left = await kit.withOrg({ orgId }, (db) =>
      db
        .select({ endpoint: pushSubscriptions.endpoint })
        .from(pushSubscriptions)
    )
    expect(left.map((r) => r.endpoint)).toEqual([endpoints[2]])
    expect(await rowOf(orgId, push.key)).toMatchObject({ state: "sent" })
  })

  it("retries when every browser answers with a server error, and keeps them", async () => {
    vi.stubGlobal("fetch", fetchMock)
    fetchMock.mockImplementation(
      async () => new Response(null, { status: 503 })
    )
    const { orgId, conversationId } = await owner(2)
    const { env } = stubs()
    const push: DeliveryMessage = {
      orgId,
      key: "heartbeat:o:j:5:push",
      channel: "push",
      kind: "heartbeat",
      title: "Your assistant",
      body: "Something to see.",
      ttl: 6 * 3600,
      conversationId,
    }
    await deliver(kit, env, push)
    const done = await consume(env, push)
    expect(done.retry).toHaveBeenCalled()
    expect(await rowOf(orgId, push.key)).toMatchObject({ state: "pending" })
    const left = await kit.withOrg({ orgId }, (db) =>
      db.select().from(pushSubscriptions)
    )
    expect(left).toHaveLength(2)
  })

  it("does not call an endpoint that is no push service", async () => {
    vi.stubGlobal("fetch", fetchMock)
    const { orgId, conversationId } = await owner(0)
    await kit.withOrg({ orgId }, async (db) => {
      const [chief] = await db.execute<{ id: string }>(
        sql`select id from staff where staff_code = 'COS-001'`
      )
      await db.insert(pushSubscriptions).values({
        orgId,
        staffId: chief?.id as string,
        endpoint: "https://internal.example.test/hook",
        ...(await browser()),
      })
    })
    const { env } = stubs()
    const push: DeliveryMessage = {
      orgId,
      key: "heartbeat:o:j:6:push",
      channel: "push",
      kind: "heartbeat",
      title: "Your assistant",
      body: "Something to see.",
      ttl: 6 * 3600,
      conversationId,
    }
    await deliver(kit, env, push)
    await consume(env, push)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await rowOf(orgId, push.key)).toMatchObject({ state: "suppressed" })
  })
})
