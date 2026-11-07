import { tenancy, whatsappAccounts } from "@workspace/db"
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { hashCode, sealToken } from "../src/channels/token.ts"
import {
  splitText,
  TEXT_MAX,
  whatsAppText,
} from "../src/channels/whatsapp/format.ts"
import { type ChannelJob, channelTurn } from "../src/channels/whatsapp/turn.ts"
import { DEFAULT_MODEL } from "../src/cos/agent.ts"
import worker from "../src/index.ts"
import audioFixture from "./fixtures/whatsapp/audio-message.json" with {
  type: "json",
}
import imageFixture from "./fixtures/whatsapp/image-message.json" with {
  type: "json",
}
import statusFixture from "./fixtures/whatsapp/status.json" with {
  type: "json",
}
import textFixture from "./fixtures/whatsapp/text-message.json" with {
  type: "json",
}
import { type Owner, owner, SUFFIX, stubOrchestrator } from "./owner-fixture.ts"
import { env } from "./sealed-session.ts"

const SECRET = "s".repeat(32)
const VERIFY = "v".repeat(32)
const TOKEN_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
const PATH = "http://api.invalid/channels/whatsapp/webhook"

const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext

/** The recorded delivery with this number, sender, wamid and words. */
function delivery(phone: string, from: string, id: string, text: string) {
  const [message] = textFixture.entry[0]?.changes[0]?.value.messages ?? []
  return JSON.stringify(textFixture)
    .replace("106540352242922", phone)
    .replaceAll("16505551234", from)
    .replace(message?.id as string, id)
    .replace(message?.text.body as string, JSON.stringify(text).slice(1, -1))
}

/** The recorded voice note with this number, sender and wamid. */
function voiceDelivery(phone: string, from: string, id: string) {
  const [message] = audioFixture.entry[0]?.changes[0]?.value.messages ?? []
  return JSON.stringify(audioFixture)
    .replace("106540352242922", phone)
    .replaceAll("16505551234", from)
    .replace(message?.id as string, id)
}

/** The recorded photo with this number, sender and wamid; `media` swaps its media id. */
function photoDelivery(
  phone: string,
  from: string,
  id: string,
  media?: string
) {
  const [message] = imageFixture.entry[0]?.changes[0]?.value.messages ?? []
  return JSON.stringify(imageFixture)
    .replace("106540352242922", phone)
    .replaceAll("16505551234", from)
    .replace(message?.id as string, id)
    .replace("1003383421387999", media ?? "1003383421387999")
}

async function signature(raw: string, secret = SECRET) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
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

describe("WhatsApp formatting", () => {
  it("writes markdown as WhatsApp does and leaves code alone", () => {
    expect(
      whatsAppText(
        "## **Today**\n**Two** jobs, *one* new. ~~old~~ [site](https://a.example)\n`**x**`\n```\n**y**\n```"
      )
    ).toBe(
      "*Today*\n*Two* jobs, _one_ new. ~old~ site (https://a.example)\n`**x**`\n```\n**y**\n```"
    )
  })

  it("keeps a short reply whole and splits a long one under the limit", () => {
    expect(splitText("Hello.")).toEqual(["Hello."])
    const long = Array.from(
      { length: 300 },
      (_, i) => `Line ${i} ${"x".repeat(40)}`
    ).join("\n\n")
    const parts = splitText(long)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((p) => p.length <= TEXT_MAX)).toBe(true)
    expect(parts.join("\n\n")).toBe(long)
  })

  it("closes and reopens a code fence it cuts", () => {
    const parts = splitText(`\`\`\`\n${"code line\n".repeat(600)}\`\`\``)
    expect(parts.length).toBe(2)
    for (const part of parts) {
      expect(part.match(/```/g)?.length).toBe(2)
      expect(part.length).toBeLessThanOrEqual(TEXT_MAX)
    }
  })
})

describe("the webhook's front door", () => {
  const bindings = (extra: Record<string, unknown> = {}) =>
    ({
      ...env("postgresql://127.0.0.1:1/none"),
      WHATSAPP_ENABLED: "1",
      WHATSAPP_APP_SECRET: SECRET,
      WHATSAPP_VERIFY_TOKEN: VERIFY,
      ...extra,
    }) as unknown as Env

  it("is not a route while the gate is off", async () => {
    const raw = JSON.stringify(statusFixture)
    const response = await worker.fetch(
      new Request(PATH, {
        method: "POST",
        body: raw,
        headers: { "x-hub-signature-256": await signature(raw) },
      }),
      bindings({ WHATSAPP_ENABLED: undefined }),
      ctx
    )
    expect(response.status).toBe(404)
  })

  it("answers Meta's handshake only with the verify token", async () => {
    const ask = (token: string) =>
      worker.fetch(
        new Request(
          `${PATH}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1158201444`
        ),
        bindings(),
        ctx
      )
    const good = await ask(VERIFY)
    expect(good.status).toBe(200)
    expect(await good.text()).toBe("1158201444")
    expect((await ask("wrong")).status).toBe(403)
  })

  it("refuses a bad or missing signature with 401", async () => {
    const raw = JSON.stringify(statusFixture)
    const post = (headers: Record<string, string>) =>
      worker.fetch(
        new Request(PATH, { method: "POST", body: raw, headers }),
        bindings(),
        ctx
      )
    expect(
      (await post({ "x-hub-signature-256": await signature(raw, "other") }))
        .status
    ).toBe(401)
    expect((await post({})).status).toBe(401)
  })

  it("refuses a body over Meta's 3 MB", async () => {
    const response = await worker.fetch(
      new Request(PATH, {
        method: "POST",
        body: "x".repeat(3 * 1024 * 1024 + 1),
        headers: { "x-hub-signature-256": "sha256=00" },
      }),
      bindings(),
      ctx
    )
    expect(response.status).toBe(413)
  })
})

const url = process.env.DATABASE_URL

describe.skipIf(!url)("WhatsApp messages to the CoS", () => {
  const kit = tenancy(url as string, { max: 4 })
  const admin = postgres(url as string, { max: 2 })
  const jobs: ChannelJob[] = []
  const graph: { path: string; body: Record<string, unknown> }[] = []
  let realFetch: typeof fetch
  let a: Owner & { phone: string }
  let b: Owner & { phone: string }
  let run = 0
  const speech: { model: string; contentType: string }[] = []
  const stored: string[] = []
  let recognise: (model: string) => unknown = () => ({
    results: {
      channels: [
        { alternatives: [{ transcript: "Move Friday's clean to Monday." }] },
      ],
    },
  })

  const bindings = () =>
    ({
      ...env(url as string),
      WHATSAPP_ENABLED: "1",
      WHATSAPP_APP_SECRET: SECRET,
      CHANNEL_TOKEN_KEY: TOKEN_KEY,
      AI: {
        run: async (
          model: string,
          input: { audio: { contentType: string } }
        ) => {
          speech.push({ model, contentType: input.audio.contentType })
          return recognise(model)
        },
      },
      SITES: {
        put: async (key: string) => void stored.push(key),
        delete: async () => undefined,
      },
      ORCHESTRATOR: stubOrchestrator(),
      SITE_HOST_SUFFIX: SUFFIX,
      SCHEDULE: { get: async () => null, put: async () => undefined },
      JOBS: { send: async () => undefined },
      AFTER_TURN: {
        send: async (body: { kind?: string }) => {
          if (body.kind === "channel") jobs.push(body as ChannelJob)
        },
      },
    }) as unknown as Env

  const post = async (raw: string) =>
    worker.fetch(
      new Request(PATH, {
        method: "POST",
        body: raw,
        headers: { "x-hub-signature-256": await signature(raw) },
      }),
      bindings(),
      ctx
    )

  /** An owner with a WhatsApp number, active. */
  async function withNumber(tag: string) {
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
        source: "dev",
        status: "active",
      })
    )
    return { ...made, phone }
  }

  /** A fresh one-time code for the owner, as the settings page mints it. */
  async function code(who: Owner) {
    const plain = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
    await admin`
      insert into channel_link_codes (hash, org_id, user_id, kind, expires_at)
      select ${await hashCode(plain)}, ${who.orgId}, u.id, 'whatsapp', now() + interval '10 minutes'
      from users u where u.workos_user_id = ${who.workosUserId}`
    return plain
  }

  const sender = () =>
    `4477009${String(++run).padStart(5, "0")}${Math.floor(Math.random() * 10)}`
  const wamid = () => `wamid.${crypto.randomUUID()}`
  const sent = () => graph.filter((g) => g.body.type === "text")

  function scripted(...replies: string[]) {
    const prompts: string[] = []
    const model = new MockLanguageModelV4({
      modelId: DEFAULT_MODEL,
      doStream: async (options) => {
        prompts.push(JSON.stringify(options.prompt))
        return {
          stream: convertArrayToReadableStream([
            { type: "stream-start", warnings: [] },
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: replies.shift() ?? "Done." },
            { type: "text-end", id: "t1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: {
                  total: 1_000,
                  noCache: 1_000,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 50, text: 50, reasoning: 0 },
              },
            },
          ]) as never,
        }
      },
    })
    return { model, prompts }
  }

  /** Links `from` to the owner through the webhook, as their phone would. */
  async function link(who: Owner & { phone: string }, from: string) {
    expect(
      (
        await post(
          delivery(who.phone, from, wamid(), `Connect Reme ${await code(who)}`)
        )
      ).status
    ).toBe(200)
  }

  beforeAll(async () => {
    realFetch = globalThis.fetch
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const target = String(input instanceof Request ? input.url : input)
      if (target.startsWith("https://lookaside.fbsbx.com/")) {
        if (target.endsWith("1003383421387999"))
          return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]))
        if (target.endsWith("1003383421387998"))
          return new Response("not a picture, just words")
        return new Response(new Uint8Array([79, 103, 103, 83]))
      }
      if (target.endsWith("/1003383421387256"))
        return Response.json({
          url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1003383421387256",
          mime_type: "audio/ogg",
          file_size: 4,
        })
      if (/\/100338342138799[89]$/.test(target))
        return Response.json({
          url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${target.slice(-16)}`,
          mime_type: "image/jpeg",
          file_size: 6,
        })
      if (!target.startsWith("https://graph.facebook.com/"))
        return realFetch(input, init)
      graph.push({
        path: new URL(target).pathname,
        body: JSON.parse(String(init?.body ?? "{}")),
      })
      return Response.json({ messages: [{ id: wamid() }] })
    }) as typeof fetch
    a = await withNumber("wa-a")
    b = await withNumber("wa-b")
  }, 60_000)

  beforeEach(() => {
    jobs.length = 0
    graph.length = 0
    speech.length = 0
    stored.length = 0
  })

  afterAll(async () => {
    globalThis.fetch = realFetch
    await admin.end()
    await kit.close()
  })

  it("ignores delivery statuses", async () => {
    const raw = JSON.stringify(statusFixture).replace(
      "106540352242922",
      a.phone
    )
    expect((await post(raw)).status).toBe(200)
    expect(jobs).toEqual([])
    expect(graph).toEqual([])
  })

  it("links a sender with a code, welcomes them, and replies in the right org", async () => {
    const from = sender()
    await link(a, from)
    expect(sent()).toHaveLength(1)
    expect(sent()[0]?.body).toMatchObject({
      to: from,
      text: {
        body: `You're connected to ${a.name}. Message me here any time.`,
      },
    })
    expect(sent()[0]?.path).toBe(`/v27.0/${a.phone}/messages`)

    graph.length = 0
    expect(
      (await post(delivery(a.phone, from, wamid(), "What is on today?"))).status
    ).toBe(200)
    expect(jobs).toEqual([
      { kind: "channel", orgId: a.orgId, linkId: expect.any(String) },
    ])
    const { model } = scripted("Two cleans today.")
    expect(
      await channelTurn(bindings(), kit, jobs[0] as ChannelJob, { model })
    ).toBe("ran")
    expect(sent().map((s) => s.body.text)).toEqual([
      { preview_url: false, body: "Two cleans today." },
    ])
    expect(graph.some((g) => g.body.status === "read")).toBe(true)

    const [row] = await admin<
      {
        conversation_id: string
        last_inbound_at: Date | null
        org_id: string
      }[]
    >`
      select conversation_id, last_inbound_at, org_id from channel_links where id = ${jobs[0]?.linkId as string}`
    expect(row?.org_id).toBe(a.orgId)
    expect(row?.last_inbound_at).not.toBeNull()
    const messages = await admin<{ id: string; org_id: string }[]>`
      select id, org_id from conversation_messages where conversation_id = ${row?.conversation_id as string} order by seq`
    expect(messages[0]?.id).toMatch(/^wa_[A-Za-z0-9_-]{43}$/)
    expect(messages.every((m) => m.org_id === a.orgId)).toBe(true)
  })

  it("never links or reaches another org", async () => {
    const from = sender()
    // A's code sent to B's number.
    expect(
      (
        await post(
          delivery(b.phone, from, wamid(), `Connect Reme ${await code(a)}`)
        )
      ).status
    ).toBe(200)
    expect(graph).toEqual([])
    await link(a, from)
    graph.length = 0
    expect(
      (await post(delivery(b.phone, from, wamid(), "Hello B?"))).status
    ).toBe(200)
    expect(jobs).toEqual([])
    const links =
      await admin`select id from channel_links where org_id = ${b.orgId}`
    expect(links).toHaveLength(0)
  })

  it("makes no second turn for a replayed wamid", async () => {
    const from = sender()
    await link(a, from)
    const raw = delivery(a.phone, from, wamid(), "Book Mrs Patel for Friday.")
    expect((await post(raw)).status).toBe(200)
    expect((await post(raw)).status).toBe(200)
    const { model, prompts } = scripted("Booked.")
    const outcomes = []
    for (const job of jobs)
      outcomes.push(await channelTurn(bindings(), kit, job, { model }))
    expect(outcomes).toEqual(["ran", "idle"])
    expect(prompts).toHaveLength(1)
    expect((await post(raw)).status).toBe(200)
    expect(
      await channelTurn(bindings(), kit, jobs.at(-1) as ChannelJob, { model })
    ).toBe("idle")
    expect(prompts).toHaveLength(1)
  })

  it("marks an owner's message read and shows typing as it lands, before the turn", async () => {
    const from = sender()
    await link(a, from)
    graph.length = 0
    const id = wamid()
    const raw = delivery(a.phone, from, id, "What's on today?")
    const pending: Promise<unknown>[] = []
    const collecting = {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
    } as unknown as ExecutionContext
    const response = await worker.fetch(
      new Request(PATH, {
        method: "POST",
        body: raw,
        headers: { "x-hub-signature-256": await signature(raw) },
      }),
      bindings(),
      collecting
    )
    expect(response.status).toBe(200)
    await Promise.all(pending)
    expect(graph.map((g) => g.body)).toEqual([
      {
        messaging_product: "whatsapp",
        status: "read",
        message_id: id,
        typing_indicator: { type: "text" },
      },
    ])
    expect(jobs).toHaveLength(1)
  })

  it("makes one turn of three quick messages", async () => {
    const from = sender()
    await link(a, from)
    graph.length = 0
    for (const text of ["First thing.", "Second thing.", "Third thing."]) {
      expect((await post(delivery(a.phone, from, wamid(), text))).status).toBe(
        200
      )
    }
    expect(jobs).toHaveLength(3)
    const { model, prompts } = scripted("All three noted.")
    const outcomes = []
    for (const job of jobs)
      outcomes.push(await channelTurn(bindings(), kit, job, { model }))
    expect(outcomes).toEqual(["ran", "idle", "idle"])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain(
      "First thing.\\n\\nSecond thing.\\n\\nThird thing."
    )
    expect(sent()).toHaveLength(1)
  })

  it("splits a long reply into messages under WhatsApp's limit", async () => {
    const from = sender()
    await link(a, from)
    graph.length = 0
    expect(
      (await post(delivery(a.phone, from, wamid(), "Write it all out."))).status
    ).toBe(200)
    const long = Array.from(
      { length: 200 },
      (_, i) => `Step ${i}: ${"y".repeat(50)}`
    ).join("\n\n")
    const { model } = scripted(long)
    expect(
      await channelTurn(bindings(), kit, jobs[0] as ChannelJob, { model })
    ).toBe("ran")
    const bodies = sent().map((s) => (s.body.text as { body: string }).body)
    expect(bodies.length).toBeGreaterThan(1)
    expect(bodies.every((t) => t.length <= TEXT_MAX)).toBe(true)
    expect(bodies.join("\n\n")).toBe(long)
  })

  it("drops a revoked sender's messages", async () => {
    const from = sender()
    await link(a, from)
    await admin`update channel_links set revoked_at = now() where external_id = ${from}`
    expect(
      (await post(delivery(a.phone, from, wamid(), "Still there?"))).status
    ).toBe(200)
    expect(jobs).toEqual([])
  })

  it("runs no turn for a person who is no longer an active owner", async () => {
    const c = await withNumber("wa-c")
    const from = sender()
    await link(c, from)
    expect(
      (await post(delivery(c.phone, from, wamid(), "Hello?"))).status
    ).toBe(200)
    await admin`
      update memberships set status = 'suspended'
      where org_id = ${c.orgId} and user_id = (select id from users where workos_user_id = ${c.workosUserId})`
    const { model, prompts } = scripted()
    expect(
      await channelTurn(bindings(), kit, jobs[0] as ChannelJob, { model })
    ).toBe("gone")
    expect(prompts).toHaveLength(0)
  })

  it("answers a voice note from its transcript and says what it heard", async () => {
    const from = sender()
    await link(a, from)
    graph.length = 0
    expect((await post(voiceDelivery(a.phone, from, wamid()))).status).toBe(200)
    const { model, prompts } = scripted("Moved it.")
    expect(
      await channelTurn(bindings(), kit, jobs[0] as ChannelJob, { model })
    ).toBe("ran")
    expect(speech).toEqual([
      { model: "@cf/deepgram/nova-3", contentType: "audio/ogg" },
    ])
    expect(prompts[0]).toContain("Move Friday's clean to Monday.")
    expect(sent().map((s) => (s.body.text as { body: string }).body)).toEqual([
      "Heard: \u201cMove Friday's clean to Monday.\u201d\n\nMoved it.",
    ])
  })

  it("falls back to Whisper when Nova-3 hears nothing", async () => {
    const from = sender()
    await link(a, from)
    expect((await post(voiceDelivery(a.phone, from, wamid()))).status).toBe(200)
    recognise = (m) =>
      m === "@cf/deepgram/nova-3"
        ? { results: { channels: [{ alternatives: [{ transcript: "" }] }] } }
        : { text: " Cancel Tuesday. " }
    const { model, prompts } = scripted("Cancelled.")
    try {
      expect(
        await channelTurn(bindings(), kit, jobs[0] as ChannelJob, { model })
      ).toBe("ran")
    } finally {
      recognise = () => ({})
    }
    expect(speech.map((s) => s.model)).toEqual([
      "@cf/deepgram/nova-3",
      "@cf/openai/whisper-large-v3-turbo",
    ])
    expect(prompts[0]).toContain("Cancel Tuesday.")
  })

  it("keeps a photo as an upload and tells the turn about it with its caption", async () => {
    const from = sender()
    await link(a, from)
    graph.length = 0
    expect((await post(photoDelivery(a.phone, from, wamid()))).status).toBe(200)
    const { model, prompts } = scripted("Got it.")
    expect(
      await channelTurn(bindings(), kit, jobs[0] as ChannelJob, { model })
    ).toBe("ran")
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatch(new RegExp(`^uploads/${a.orgId}/`))
    expect(prompts[0]).toMatch(/The owner sent a photo: whatsapp-[\w-]+\.jpg/)
    expect(prompts[0]).toContain("Use this for the gallery")
    const [facts] = await admin`
      select value from facts where org_id = ${a.orgId} and key = 'media.uploads' order by created_at desc limit 1`
    expect(JSON.stringify(facts?.value)).toContain("image/jpeg")
  })

  it("refuses a photo that is not an image without a turn", async () => {
    const from = sender()
    await link(b, from)
    graph.length = 0
    expect(
      (await post(photoDelivery(b.phone, from, wamid(), "1003383421387998")))
        .status
    ).toBe(200)
    const { model, prompts } = scripted()
    expect(
      await channelTurn(bindings(), kit, jobs[0] as ChannelJob, { model })
    ).toBe("idle")
    expect(prompts).toHaveLength(0)
    expect(stored).toHaveLength(0)
    expect(sent()[0]?.body.text).toMatchObject({
      body: expect.stringMatching(/couldn't keep that photo/),
    })
  })

  it("asks for a retype when no speech model can hear the note", async () => {
    const from = sender()
    await link(a, from)
    graph.length = 0
    expect((await post(voiceDelivery(a.phone, from, wamid()))).status).toBe(200)
    recognise = () => {
      throw new Error("model down")
    }
    const { model, prompts } = scripted()
    expect(
      await channelTurn(bindings(), kit, jobs[0] as ChannelJob, { model })
    ).toBe("idle")
    expect(prompts).toHaveLength(0)
    expect(sent()).toHaveLength(1)
    expect(sent()[0]?.body.text).toMatchObject({
      body: expect.stringMatching(/couldn't make out that voice note/),
    })
    const [open] = await admin`
      select count(*)::int as n from channel_inbound where link_id = ${jobs[0]?.linkId as string} and processed_at is null`
    expect(open?.n).toBe(0)
  })
})
