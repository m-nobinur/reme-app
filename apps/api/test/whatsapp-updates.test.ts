import { deliveries, tenancy, whatsappAccounts } from "@workspace/db"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { sealToken } from "../src/channels/token.ts"
import {
  ensureTemplates,
  sendUpdate,
  type WhatsAppUpdate,
} from "../src/channels/whatsapp/templates.ts"
import { type ChannelJob, channelTurn } from "../src/channels/whatsapp/turn.ts"
import worker from "../src/index.ts"
import tapFixture from "./fixtures/whatsapp/template-tap.json" with {
  type: "json",
}
import { type Owner, owner } from "./owner-fixture.ts"
import { env } from "./sealed-session.ts"

const SECRET = "s".repeat(32)
const TOKEN_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext

type Call = { method: string; path: string; body: Record<string, unknown> }
const graph: Call[] = []
let respond: (call: Call) => Response = () =>
  Response.json({ messages: [{ id: `wamid.${crypto.randomUUID()}` }] })
let realFetch: typeof fetch

beforeAll(() => {
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input)
    if (!target.startsWith("https://graph.facebook.com/"))
      return realFetch(input, init)
    const url = new URL(target)
    const call = {
      method: init?.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      body: JSON.parse(String(init?.body ?? "{}")),
    }
    graph.push(call)
    return respond(call)
  }) as typeof fetch
})

beforeEach(() => {
  graph.length = 0
  respond = () =>
    Response.json({ messages: [{ id: `wamid.${crypto.randomUUID()}` }] })
})

afterAll(() => {
  globalThis.fetch = realFetch
})

describe("the update template on a business's WABA", () => {
  const sender = { phoneNumberId: "106540352242922", token: "t" }

  it("is created when missing, and left alone when there", async () => {
    respond = ({ method }) =>
      Response.json(method === "GET" ? { data: [] } : { id: "1" })
    await ensureTemplates(sender, "102290129340398")
    expect(graph.map((c) => [c.method, c.path])).toEqual([
      [
        "GET",
        "/v27.0/102290129340398/message_templates?name=reme_update&fields=name",
      ],
      ["POST", "/v27.0/102290129340398/message_templates"],
    ])
    expect(graph[1]?.body).toMatchObject({
      name: "reme_update",
      language: "en_GB",
      category: "UTILITY",
      components: [
        { type: "BODY", text: "You have an update from Reme about {{1}}." },
        {
          type: "BUTTONS",
          buttons: [{ type: "QUICK_REPLY", text: "See update" }],
        },
      ],
    })

    graph.length = 0
    respond = () => Response.json({ data: [{ name: "reme_update" }] })
    await ensureTemplates(sender, "102290129340398")
    expect(graph.map((c) => c.method)).toEqual(["GET"])
  })
})

const url = process.env.DATABASE_URL

describe.skipIf(!url)("updates to the owner's WhatsApp", () => {
  const kit = tenancy(url as string, { max: 4 })
  const admin = postgres(url as string, { max: 2 })
  const released: WhatsAppUpdate[] = []
  const jobs: ChannelJob[] = []
  let who: Owner & { phone: string }
  let run = 0

  const bindings = () =>
    ({
      ...env(url as string),
      WHATSAPP_ENABLED: "1",
      WHATSAPP_APP_SECRET: SECRET,
      CHANNEL_TOKEN_KEY: TOKEN_KEY,
      AFTER_TURN: {
        send: async (body: ChannelJob) => void jobs.push(body),
        sendBatch: async (batch: { body: WhatsAppUpdate }[]) =>
          void released.push(...batch.map((m) => m.body)),
      },
    }) as unknown as Env

  /** `HH:MM` in UTC, `hours` from now. */
  const clock = (hours: number) =>
    new Date(Date.now() + hours * 3_600_000).toISOString().slice(11, 16)

  const quiet = (start: string, end: string) =>
    admin`update orgs set time_zone = 'UTC', quiet_start = ${start}, quiet_end = ${end} where id = ${who.orgId}`

  /** A linked chat whose owner last wrote `hoursAgo` hours ago. */
  async function chat(hoursAgo: number, updates = true) {
    const externalId = `4477009${String(++run).padStart(5, "0")}`
    const [row] = await admin<{ id: string }[]>`
      insert into channel_links (org_id, user_id, account_id, external_id, label, updates, last_inbound_at)
      select m.org_id, m.user_id, a.id, ${externalId}, 'Probe', ${updates}, now() - ${`${hoursAgo} hours`}::interval
      from memberships m join whatsapp_accounts a on a.org_id = m.org_id
      where m.org_id = ${who.orgId}
      returning id`
    return { linkId: row?.id as string, externalId }
  }

  /** The outbox row the orchestrator writes for one in-app message. */
  async function update(linkId: string, kind: string, text: string) {
    const body: WhatsAppUpdate = {
      channel: "whatsapp",
      orgId: who.orgId,
      key: `${kind}:${crypto.randomUUID()}:whatsapp:${linkId}`,
      linkId,
      kind,
      text,
    }
    await kit.withOrg({ orgId: who.orgId }, (db) =>
      db.insert(deliveries).values({
        orgId: who.orgId,
        key: body.key,
        channel: "whatsapp",
        payload: body,
      })
    )
    return body
  }

  const rowOf = async (key: string) => {
    const [row] = await admin<
      { state: string; lease_until: Date | null; payload: unknown }[]
    >`select state, lease_until, payload from deliveries where key = ${key}`
    return row
  }
  const texts = () =>
    graph.flatMap((c) =>
      c.body.type === "text" ? [(c.body.text as { body: string }).body] : []
    )
  const templates = () => graph.filter((c) => c.body.type === "template")

  beforeAll(async () => {
    const made = await owner(kit, url as string, "wa-up")
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
        source: "dev",
        status: "active",
      })
    )
    who = { ...made, phone }
  }, 60_000)

  beforeEach(() => {
    released.length = 0
    jobs.length = 0
  })

  afterAll(async () => {
    await admin.end()
    await kit.close()
  })

  it("sends an update as text while the window is open", async () => {
    const { linkId, externalId } = await chat(1)
    const body = await update(linkId, "heartbeat", "**Two** jobs tomorrow.")
    expect(await sendUpdate(bindings(), kit, body)).toBe("text")
    expect(graph[0]?.body).toMatchObject({
      to: externalId,
      text: { body: "*Two* jobs tomorrow." },
    })
    expect(await rowOf(body.key)).toMatchObject({
      state: "sent",
      payload: null,
    })
    expect(await sendUpdate(bindings(), kit, body)).toBe("busy")
    expect(graph).toHaveLength(1)
  })

  it("sends the template once a day outside the window, then the held updates on the tap", async () => {
    await quiet(clock(12), clock(12))
    const { linkId, externalId } = await chat(30)
    const first = await update(linkId, "heartbeat", "A quote is waiting.")
    const second = await update(linkId, "reminder", "Call Mrs Patel.")
    expect(await sendUpdate(bindings(), kit, first)).toBe("template")
    expect(await sendUpdate(bindings(), kit, second)).toBe("held")
    expect(texts()).toEqual([])
    expect(templates()).toHaveLength(1)
    expect(templates()[0]?.body).toMatchObject({
      to: externalId,
      template: {
        name: "reme_update",
        language: { code: "en_GB" },
        components: [
          {
            type: "body",
            parameters: [{ type: "text", text: "your business" }],
          },
          {
            type: "button",
            sub_type: "quick_reply",
            index: "0",
            parameters: [{ type: "payload", payload: "see_update" }],
          },
        ],
      },
    })
    for (const { key } of [first, second]) {
      const row = await rowOf(key)
      expect(row?.state).toBe("sending")
      expect(row?.lease_until?.getTime()).toBeGreaterThan(
        Date.now() + 11 * 3_600_000
      )
    }

    graph.length = 0
    const raw = JSON.stringify(tapFixture)
      .replace("106540352242922", who.phone)
      .replaceAll("16505551234", externalId)
      .replace(
        tapFixture.entry[0]?.changes[0]?.value.messages[0]?.id as string,
        `wamid.${crypto.randomUUID()}`
      )
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    )
    const mac = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw))
    )
    const tapped = await worker.fetch(
      new Request("http://api.invalid/channels/whatsapp/webhook", {
        method: "POST",
        body: raw,
        headers: {
          "x-hub-signature-256": `sha256=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`,
        },
      }),
      bindings(),
      ctx
    )
    expect(tapped.status).toBe(200)
    expect(jobs).toHaveLength(1)
    expect(await channelTurn(bindings(), kit, jobs[0] as ChannelJob)).toBe(
      "idle"
    )
    expect(released.map((r) => r.key).sort()).toEqual(
      [first.key, second.key].sort()
    )
    for (const each of released) {
      expect(await sendUpdate(bindings(), kit, each)).toBe("text")
    }
    expect(texts().sort()).toEqual(["A quote is waiting.", "Call Mrs Patel."])
    expect(templates()).toEqual([])
    expect(await rowOf(first.key)).toMatchObject({ state: "sent" })
  })

  it("holds an update through quiet hours, but not the owner's reminder", async () => {
    await quiet(clock(-1), clock(1))
    const { linkId } = await chat(30)
    const beat = await update(linkId, "heartbeat", "Nothing urgent.")
    expect(await sendUpdate(bindings(), kit, beat)).toBe("held")
    expect(graph).toEqual([])
    const lease = (await rowOf(beat.key))?.lease_until?.getTime() ?? 0
    expect(lease).toBeGreaterThan(Date.now())
    expect(lease).toBeLessThanOrEqual(Date.now() + 3_600_000)

    const reminder = await update(linkId, "reminder", "Lock up.")
    expect(await sendUpdate(bindings(), kit, reminder)).toBe("template")
    expect(templates()[0]?.body.template).toMatchObject({
      components: [{ parameters: [{ text: "a reminder" }] }, {}],
    })
  })

  it("falls back to the template when Meta says the window has closed", async () => {
    await quiet(clock(12), clock(12))
    const { linkId } = await chat(1)
    respond = (call) =>
      call.body.type === "text"
        ? Response.json({ error: { code: 131047 } }, { status: 400 })
        : Response.json({ messages: [{ id: "wamid.t" }] })
    const review = await update(linkId, "heartbeat", "A new review.")
    expect(await sendUpdate(bindings(), kit, review)).toBe("template")
    expect(templates()).toHaveLength(1)
  })

  it("sends nothing to a chat with updates off", async () => {
    const { linkId } = await chat(1, false)
    const body = await update(linkId, "heartbeat", "Hidden.")
    expect(await sendUpdate(bindings(), kit, body)).toBe("gone")
    expect(graph).toEqual([])
    expect(await rowOf(body.key)).toMatchObject({ state: "suppressed" })
  })

  // Last: it demotes the suite's owner.
  it("sends nothing held for someone no longer an owner", async () => {
    const { linkId } = await chat(1)
    const body = await update(linkId, "heartbeat", "For owners only.")
    await admin`update memberships set role = 'staff' where org_id = ${who.orgId}`
    expect(await sendUpdate(bindings(), kit, body)).toBe("gone")
    expect(graph).toEqual([])
  })
})
