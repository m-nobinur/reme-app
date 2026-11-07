import { tenancy, whatsappAccounts } from "@workspace/db"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { sealToken } from "../src/channels/token.ts"
import worker from "../src/index.ts"
import textFixture from "./fixtures/whatsapp/text-message.json" with {
  type: "json",
}
import { owner, SUFFIX, stubOrchestrator } from "./owner-fixture.ts"
import { env } from "./sealed-session.ts"

const SECRET = "s".repeat(32)
const TOKEN_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
const PATH = "http://api.invalid/channels/whatsapp/webhook"
const url = process.env.DATABASE_URL
const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext

function delivery(phone: string, from: string, id: string, text: string) {
  const [message] = textFixture.entry[0]?.changes[0]?.value.messages ?? []
  return JSON.stringify(textFixture)
    .replace("106540352242922", phone)
    .replaceAll("16505551234", from)
    .replace(message?.id as string, id)
    .replace(message?.text.body as string, text)
}

async function signature(raw: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(raw)
  )
  return `sha256=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`
}

describe.skipIf(!url)("customers on a Reme-held number", () => {
  const kit = tenancy(url as string, { max: 4 })
  const admin = postgres(url as string, { max: 2 })
  const graph: { path: string; body: Record<string, unknown> }[] = []
  const queued: { key: string; message: { text: string[] } }[] = []
  let realFetch: typeof fetch
  let held: Awaited<ReturnType<typeof withNumber>>
  let coexisting: Awaited<ReturnType<typeof withNumber>>
  let run = 0

  const post = async (
    phone: string,
    from: string,
    id: string,
    text: string
  ) => {
    const raw = delivery(phone, from, id, text)
    return worker.fetch(
      new Request(PATH, {
        method: "POST",
        body: raw,
        headers: { "x-hub-signature-256": await signature(raw) },
      }),
      {
        ...env(url as string),
        WHATSAPP_ENABLED: "1",
        WHATSAPP_APP_SECRET: SECRET,
        CHANNEL_TOKEN_KEY: TOKEN_KEY,
        ORCHESTRATOR: stubOrchestrator(),
        SITE_HOST_SUFFIX: SUFFIX,
        AFTER_TURN: { send: async () => undefined },
        DELIVERIES: {
          send: async (body: (typeof queued)[number]) => {
            queued.push(body)
          },
        },
      } as unknown as Env,
      ctx
    )
  }

  async function withNumber(tag: string, coexistence: boolean) {
    const made = await owner(kit, url as string, tag)
    const phone = String(100000000000 + Math.floor(Math.random() * 1e11))
    await kit.withOrg({ orgId: made.orgId }, async (db) =>
      db.insert(whatsappAccounts).values({
        orgId: made.orgId,
        wabaId: "102290129340398",
        phoneNumberId: phone,
        displayNumber: "+447700900123",
        displayName: made.name.slice(0, 100),
        tokenCiphertext: await sealToken(
          { CHANNEL_TOKEN_KEY: TOKEN_KEY },
          made.orgId,
          "fake-token"
        ),
        source: coexistence ? "connected" : "dev",
        coexistence,
        status: "active",
      })
    )
    return { ...made, phone }
  }

  const sender = () => `4477008${String(++run).padStart(5, "0")}`
  const wamid = () => `wamid.${crypto.randomUUID()}`
  const replies = () => graph.filter((g) => g.body.type === "text")

  beforeAll(async () => {
    realFetch = globalThis.fetch
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const target = String(input instanceof Request ? input.url : input)
      if (!target.startsWith("https://graph.facebook.com/"))
        return realFetch(input, init)
      graph.push({
        path: new URL(target).pathname,
        body: JSON.parse(String(init?.body ?? "{}")),
      })
      return Response.json({ messages: [{ id: wamid() }] })
    }) as typeof fetch
    held = await withNumber("wa-held", false)
    coexisting = await withNumber("wa-coex", true)
  }, 60_000)

  beforeEach(() => {
    graph.length = 0
    queued.length = 0
  })

  afterAll(async () => {
    globalThis.fetch = realFetch
    await admin.end()
    await kit.close()
  })

  it("tells the owner and sends one holding reply a day per sender", async () => {
    const from = sender()
    const first = wamid()
    expect(
      (await post(held.phone, from, first, "Are you free Friday?")).status
    ).toBe(200)
    expect(replies().map((g) => g.body.text)).toEqual([
      {
        preview_url: false,
        body: `Thanks for your message. ${held.name} will reply soon.`,
      },
    ])
    expect(replies()[0]?.body.to).toBe(from)
    expect(queued).toHaveLength(1)
    expect(queued[0]?.message.text).toEqual([
      `A customer messaged your WhatsApp number from +${from}.`,
    ])
    expect(JSON.stringify(queued)).not.toContain("Friday")

    expect((await post(held.phone, from, wamid(), "Hello?")).status).toBe(200)
    expect(replies()).toHaveLength(1)
    expect(queued).toHaveLength(2)

    // A redelivery notifies and replies no more.
    await post(held.phone, from, first, "Are you free Friday?")
    expect(replies()).toHaveLength(1)
    expect(queued).toHaveLength(2)

    const rows = await admin`
      select key, channel from deliveries where org_id = ${held.orgId} and key like ${`customer%${from}%`}`
    expect(rows.map((r) => r.channel)).toEqual(["whatsapp"])

    await post(held.phone, sender(), wamid(), "Another customer")
    expect(replies()).toHaveLength(2)
  })

  it("leaves a Coexistence number's customers to the business's own app", async () => {
    expect((await post(coexisting.phone, sender(), wamid(), "Hi")).status).toBe(
      200
    )
    expect(graph).toEqual([])
    expect(queued).toEqual([])
    const rows = await admin`
      select 1 from deliveries where org_id = ${coexisting.orgId} and key like 'customer%'`
    expect(rows).toHaveLength(0)
  })
})
