import { eq, reminders, tenancy, whatsappAccounts } from "@workspace/db"
import type { UIMessage } from "ai"
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test"
import postgres from "postgres"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { hashCode, sealToken } from "../src/channels/token.ts"
import { extraOf, sendReply, tapOf } from "../src/channels/whatsapp/reply.ts"
import { type ChannelJob, channelTurn } from "../src/channels/whatsapp/turn.ts"
import { DEFAULT_MODEL } from "../src/cos/agent.ts"
import worker from "../src/index.ts"
import buttonFixture from "./fixtures/whatsapp/button-reply.json" with {
  type: "json",
}
import textFixture from "./fixtures/whatsapp/text-message.json" with {
  type: "json",
}
import { type Owner, owner, SUFFIX, stubOrchestrator } from "./owner-fixture.ts"
import { env, stubJwksFetch } from "./sealed-session.ts"

const SECRET = "s".repeat(32)
const TOKEN_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)))
const ORIGIN = "https://preview.remeai.co.uk"
const PATH = "http://api.invalid/channels/whatsapp/webhook"
const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext

type Sent = { path: string; body: Record<string, unknown> }
const GRAPH = { phoneNumberId: "106540352242922", token: "t" }

/** What the global fetch records of the calls made to Meta, answering each as it would. */
function recordGraph(
  into: Sent[],
  answer: (body: Record<string, unknown>) => Response = () =>
    Response.json({ messages: [{ id: `wamid.${crypto.randomUUID()}` }] })
) {
  const real = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input)
    if (!target.startsWith("https://graph.facebook.com/"))
      return real(input, init)
    const body = JSON.parse(String(init?.body ?? "{}"))
    into.push({ path: new URL(target).pathname, body })
    return answer(body)
  }) as typeof fetch
  return () => {
    globalThis.fetch = real
  }
}

const message = (parts: object[]): UIMessage =>
  ({ id: "m1", role: "assistant", parts }) as unknown as UIMessage

const card = (tool: string, approval: string | null, id = "call_1") => ({
  type: `tool-${tool}`,
  toolCallId: id,
  state: approval ? "approval-requested" : "input-available",
  input: {},
  ...(approval ? { approval: { id: approval } } : {}),
})

const offer = (...labels: string[]) => ({
  type: "tool-offer_choices",
  toolCallId: "call_offer",
  state: "output-available",
  input: {
    choices: labels.map((label) => ({ label, send: `I choose ${label}` })),
  },
  output: { outcome: "offered" },
})

describe("how a reply asks what comes next", () => {
  it("makes one reminder approval into Approve and Not now", () => {
    expect(
      extraOf(
        message([{ type: "step-start" }, card("create_reminder", "ap_1")]),
        true
      )
    ).toEqual({ kind: "approval", id: "ap_1" })
  })

  it("sends every other card, and a bare approval, to the web", () => {
    const link = { kind: "link", label: "Open Reme to approve" }
    // Always-ask tools, and a step with more than one card.
    for (const parts of [
      [card("remove_domain", "ap_1")],
      [card("offer_grant", "ap_1")],
      [card("request_change", "ap_1")],
      [
        card("create_reminder", "ap_1"),
        card("create_reminder", "ap_2", "call_2"),
      ],
      [card("create_reminder", "ap_1"), card("ask_open", null, "call_2")],
    ]) {
      expect(
        extraOf(message([{ type: "step-start" }, ...parts]), true)
      ).toMatchObject(link)
    }
    // No words to put in front of the buttons.
    expect(
      extraOf(message([card("create_reminder", "ap_1")]), false)
    ).toMatchObject(link)
  })

  it("sends a question card to the web as Open in Reme", () => {
    expect(extraOf(message([card("ask_open", null)]), true)).toMatchObject({
      kind: "link",
      label: "Open in Reme",
    })
    expect(
      extraOf(message([{ type: "data-persona", data: {} }]), true)
    ).toMatchObject({
      label: "Open in Reme",
    })
  })

  it("turns quick replies into choices, and a plain reply into none", () => {
    expect(extraOf(message([offer("Yes", "No")]), true)).toMatchObject({
      kind: "choices",
      choices: [{ label: "Yes" }, { label: "No" }],
    })
    expect(extraOf(message([{ type: "text", text: "Hi" }]), true)).toBeNull()
    // An earlier step's pills are not this reply's.
    expect(
      extraOf(message([offer("Yes"), { type: "step-start" }]), true)
    ).toBeNull()
  })

  it("reads only a tap whose id is one we sent", () => {
    const tap = (id: string, title = "T") => ({
      type: "interactive",
      interactive: { type: "button_reply", button_reply: { id, title } },
    })
    expect(tapOf(tap("ap:approval_1:y"))).toEqual({
      kind: "approval",
      approvalId: "approval_1",
      approved: true,
    })
    expect(tapOf(tap("ap:a:b:c:n"))).toMatchObject({
      approvalId: "a:b:c",
      approved: false,
    })
    expect(tapOf(tap("ch:2", "Later"))).toEqual({
      kind: "choice",
      index: 2,
      title: "Later",
    })
    for (const id of [
      "ch:3",
      "ch:",
      "ap::y",
      "ap:x:z",
      "other",
      `ap:${"x".repeat(129)}:y`,
    ]) {
      expect(tapOf(tap(id))).toBeNull()
    }
    expect(tapOf({ type: "text", text: { body: "ap:x:y" } })).toBeNull()
    expect(
      tapOf({
        type: "interactive",
        interactive: {
          type: "list_reply",
          list_reply: { id: "ch:0", title: "x" },
        },
      })
    ).toBeNull()
    expect(
      tapOf(buttonFixture.entry[0]?.changes[0]?.value.messages[0] as never)
    ).toEqual({
      kind: "choice",
      index: 0,
      title: "Yes please",
    })
  })
})

describe("the messages a reply becomes", () => {
  const sent: Sent[] = []
  let restore: () => void = () => undefined
  beforeEach(() => {
    sent.length = 0
  })
  afterAll(() => restore())
  const url = () => `${ORIGIN}/app/c/abc`
  const interactive = () =>
    sent.find((s) => s.body.type === "interactive")?.body.interactive

  it("sends the words, then the buttons with the last part as their body", async () => {
    restore = recordGraph(sent)
    await sendReply(
      GRAPH,
      "447700900123",
      "Shall I set it?",
      { kind: "approval", id: "ap_1" },
      url
    )
    restore()
    expect(sent).toHaveLength(1)
    expect(interactive()).toEqual({
      type: "button",
      body: { text: "Shall I set it?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "ap:ap_1:y", title: "Approve" } },
          { type: "reply", reply: { id: "ap:ap_1:n", title: "Not now" } },
        ],
      },
    })
  })

  it("clips a quick reply's title to 20 characters and numbers the buttons", async () => {
    restore = recordGraph(sent)
    const choices = [
      { label: "Yes, book the Friday clean", send: "Yes" },
      { label: "No", send: "No" },
      { label: "Exactly twenty chars", send: "Twenty" },
    ]
    await sendReply(
      GRAPH,
      "447700900123",
      "Which one?",
      { kind: "choices", choices },
      url
    )
    restore()
    const buttons = (
      interactive() as {
        action: { buttons: { reply: { id: string; title: string } }[] }
      }
    ).action.buttons
    expect(buttons.map((b) => b.reply.id)).toEqual(["ch:0", "ch:1", "ch:2"])
    expect(buttons.map((b) => b.reply.title)).toEqual([
      "Yes, book the Frida…",
      "No",
      "Exactly twenty chars",
    ])
    expect(buttons.every((b) => b.reply.title.length <= 20)).toBe(true)
  })

  it("sends a link as a CTA button to the conversation", async () => {
    restore = recordGraph(sent)
    await sendReply(
      GRAPH,
      "447700900123",
      "Two things need you.",
      { kind: "link", label: "Open Reme to approve", body: "x" },
      url
    )
    restore()
    expect(interactive()).toEqual({
      type: "cta_url",
      body: { text: "Two things need you." },
      action: {
        name: "cta_url",
        parameters: {
          display_text: "Open Reme to approve",
          url: `${ORIGIN}/app/c/abc`,
        },
      },
    })
  })

  it("keeps a long reply as text and puts a short line on the buttons", async () => {
    restore = recordGraph(sent)
    await sendReply(
      GRAPH,
      "447700900123",
      "w".repeat(1500),
      { kind: "choices", choices: [{ label: "Yes", send: "Yes" }] },
      url
    )
    restore()
    expect(sent.map((s) => s.body.type)).toEqual(["text", "interactive"])
    expect(sent[0]?.body.text).toEqual({
      preview_url: false,
      body: "w".repeat(1500),
    })
    expect((interactive() as { body: { text: string } }).body.text).toBe(
      "What would you like to do?"
    )
  })

  it("sends the words as text when Meta refuses the buttons", async () => {
    restore = recordGraph(sent, (body) =>
      body.type === "interactive"
        ? Response.json({ error: { code: 131009 } }, { status: 400 })
        : Response.json({ messages: [{ id: "wamid.x" }] })
    )
    await sendReply(
      GRAPH,
      "447700900123",
      "Which one?",
      { kind: "choices", choices: [{ label: "Yes", send: "Yes" }] },
      url
    )
    restore()
    expect(sent.map((s) => s.body.type)).toEqual(["interactive", "text"])
    expect(sent[1]?.body.text).toEqual({
      preview_url: false,
      body: "Which one?",
    })
  })
})

const dbUrl = process.env.DATABASE_URL

describe.skipIf(!dbUrl)("buttons, taps and words on a live connection", () => {
  const kit = tenancy(dbUrl as string, { max: 4 })
  const admin = postgres(dbUrl as string, { max: 2 })
  const jobs: ChannelJob[] = []
  const graph: Sent[] = []
  let restore: () => void
  let a: Owner & { phone: string }
  let run = 0

  const bindings = () =>
    ({
      ...env(dbUrl as string),
      WHATSAPP_ENABLED: "1",
      WHATSAPP_APP_SECRET: SECRET,
      CHANNEL_TOKEN_KEY: TOKEN_KEY,
      WEB_ORIGIN: ORIGIN,
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

  const wamid = () => `wamid.${crypto.randomUUID()}`
  const sender = () =>
    `4477009${String(++run).padStart(5, "0")}${Math.floor(Math.random() * 10)}`

  /** The recorded text delivery, with this number, sender, wamid and words. */
  function words(phone: string, from: string, id: string, text: string) {
    const [m] = textFixture.entry[0]?.changes[0]?.value.messages ?? []
    return JSON.stringify(textFixture)
      .replace("106540352242922", phone)
      .replaceAll("16505551234", from)
      .replace(m?.id as string, id)
      .replace(m?.text.body as string, JSON.stringify(text).slice(1, -1))
  }

  /** The recorded button tap, with this number, sender, wamid and button. */
  function tapped(
    phone: string,
    from: string,
    buttonId: string,
    title: string,
    id = wamid()
  ) {
    const [m] = buttonFixture.entry[0]?.changes[0]?.value.messages ?? []
    return JSON.stringify(buttonFixture)
      .replace("106540352242922", phone)
      .replaceAll("16505551234", from)
      .replace(m?.id as string, id)
      .replace('"ch:0"', JSON.stringify(buttonId))
      .replace('"Yes please"', JSON.stringify(title))
  }

  async function withNumber(tag: string) {
    const made = await owner(kit, dbUrl as string, tag)
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

  async function link(who: Owner & { phone: string }, from: string) {
    const plain = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
    await admin`
      insert into channel_link_codes (hash, org_id, user_id, kind, expires_at)
      select ${await hashCode(plain)}, ${who.orgId}, u.id, 'whatsapp', now() + interval '10 minutes'
      from users u where u.workos_user_id = ${who.workosUserId}`
    expect(
      (await post(words(who.phone, from, wamid(), `Connect Reme ${plain}`)))
        .status
    ).toBe(200)
  }

  type Step = Record<string, unknown>[]
  const usage = {
    inputTokens: { total: 1_000, noCache: 1_000, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 50, text: 50, reasoning: 0 },
  }
  const said = (reply: string): Step => [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: reply },
    { type: "text-end", id: "t1" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ]
  /** A step that says `reply`, then calls tools, so the turn stops on them. */
  const calling = (
    reply: string | null,
    ...made: { id: string; tool: string; input: unknown }[]
  ): Step => [
    { type: "stream-start", warnings: [] },
    ...(reply
      ? [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: reply },
          { type: "text-end", id: "t1" },
        ]
      : []),
    ...made.map(({ id, tool, input }) => ({
      type: "tool-call",
      toolCallId: id,
      toolName: tool,
      input: JSON.stringify(input),
    })),
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
      usage,
    },
  ]
  function scripted(...steps: Step[]) {
    const prompts: string[] = []
    const model = new MockLanguageModelV4({
      modelId: DEFAULT_MODEL,
      doStream: async (options) => {
        prompts.push(JSON.stringify(options.prompt))
        return {
          stream: convertArrayToReadableStream(
            steps.shift() ?? said("Done.")
          ) as never,
        }
      },
    })
    return { model, prompts }
  }

  /** Delivers `raw`, then runs the turns it queued. */
  async function turns(raw: string, model: MockLanguageModelV4) {
    jobs.length = 0
    expect((await post(raw)).status).toBe(200)
    const outcomes = []
    for (const job of jobs)
      outcomes.push(await channelTurn(bindings(), kit, job, { model }))
    return outcomes
  }

  type Buttons = {
    type: string
    body: { text: string }
    action: { buttons: { reply: { id: string; title: string } }[] }
  }
  const interactiveSent = () =>
    graph
      .filter((g) => g.body.type === "interactive")
      .map((g) => g.body.interactive as Buttons)
  const textsSent = () =>
    graph
      .filter((g) => g.body.type === "text")
      .map((g) => (g.body.text as { body: string }).body)
  const linkOf = async (from: string) => {
    const [row] = await admin<
      { id: string; conversation_id: string | null; revoked_at: Date | null }[]
    >`
      select id, conversation_id, revoked_at from channel_links where external_id = ${from} order by created_at desc limit 1`
    return row as {
      id: string
      conversation_id: string | null
      revoked_at: Date | null
    }
  }

  beforeAll(async () => {
    const jwks = stubJwksFetch()
    globalThis.fetch = jwks
    restore = recordGraph(graph)
    a = await withNumber("wa-btn")
  }, 60_000)

  beforeEach(() => {
    jobs.length = 0
    graph.length = 0
  })

  afterAll(async () => {
    restore()
    await admin.end()
    await kit.close()
  })

  it("offers quick replies as buttons, and a tap sends that reply's message", async () => {
    const from = sender()
    await link(a, from)
    const { model, prompts } = scripted(
      calling("Shall I book Friday?", {
        id: "call_offer",
        tool: "offer_choices",
        input: {
          choices: [
            { label: "Yes, book the Friday clean", send: "Yes, book Friday." },
            { label: "Not yet", send: "Not yet." },
          ],
        },
      }),
      said("Booked for Friday.")
    )
    graph.length = 0
    expect(
      await turns(
        words(a.phone, from, wamid(), "Can Mrs Patel come Friday?"),
        model
      )
    ).toEqual(["ran"])
    expect(interactiveSent()).toHaveLength(1)
    const [pills] = interactiveSent()
    expect(pills?.body.text).toBe("Shall I book Friday?")
    expect(pills?.action.buttons.map((b) => b.reply)).toEqual([
      { id: "ch:0", title: "Yes, book the Frida…" },
      { id: "ch:1", title: "Not yet" },
    ])

    graph.length = 0
    expect(
      await turns(tapped(a.phone, from, "ch:0", "Yes, book the Frida…"), model)
    ).toEqual(["ran"])
    expect(prompts.at(-1)).toContain("Yes, book Friday.")
    expect(textsSent()).toEqual(["Booked for Friday."])
  })

  it("refuses a tap on quick replies once anything newer has landed", async () => {
    const from = sender()
    await link(a, from)
    const { model, prompts } = scripted(
      calling("Shall I book Friday?", {
        id: "call_offer",
        tool: "offer_choices",
        input: { choices: [{ label: "Yes", send: "Yes, book Friday." }] },
      }),
      said("Noted.")
    )
    await turns(
      words(a.phone, from, wamid(), "Can Mrs Patel come Friday?"),
      model
    )
    await turns(words(a.phone, from, wamid(), "Actually, never mind."), model)
    graph.length = 0
    const before = prompts.length
    expect(await turns(tapped(a.phone, from, "ch:0", "Yes"), model)).toEqual([
      "ran",
    ])
    expect(prompts).toHaveLength(before)
    expect(textsSent()).toEqual([
      "That button is out of date. Tell me what you'd like.",
    ])
  })

  it("approves a reminder from a tap, and refuses the same tap again", async () => {
    const from = sender()
    await link(a, from)
    const { model } = scripted(
      calling("I can set a reminder to call the supplier. Shall I?", {
        id: "call_rem",
        tool: "create_reminder",
        input: { title: "Call the supplier", due_at: null },
      }),
      said("Done, I've set it.")
    )
    graph.length = 0
    expect(
      await turns(
        words(a.phone, from, wamid(), "I need to call the supplier."),
        model
      )
    ).toEqual(["ran"])
    const [ask] = interactiveSent()
    expect(ask?.type).toBe("button")
    expect(ask?.body.text).toBe(
      "I can set a reminder to call the supplier. Shall I?"
    )
    const [yes, no] = (ask as Buttons).action.buttons.map((b) => b.reply)
    expect([yes?.title, no?.title]).toEqual(["Approve", "Not now"])
    expect(yes?.id).toMatch(/^ap:.+:y$/)

    const conversationId = (await linkOf(from)).conversation_id as string
    const none = () =>
      kit.withOrg({ orgId: a.orgId }, (db) =>
        db
          .select()
          .from(reminders)
          .where(eq(reminders.conversationId, conversationId))
      )
    expect(await none()).toHaveLength(0)

    graph.length = 0
    const tap = tapped(a.phone, from, yes?.id as string, "Approve")
    expect(await turns(tap, model)).toEqual(["ran"])
    expect(await none()).toHaveLength(1)
    expect(textsSent()).toEqual(["Done, I've set it."])

    graph.length = 0
    expect(
      await turns(tapped(a.phone, from, yes?.id as string, "Approve"), model)
    ).toEqual(["ran"])
    expect(await none()).toHaveLength(1)
    expect(textsSent()).toEqual([
      "That button is out of date. Tell me what you'd like.",
    ])
  })

  it("makes nothing of a Not now tap", async () => {
    const from = sender()
    await link(a, from)
    const { model } = scripted(
      calling("Shall I set a reminder to chase the invoice?", {
        id: "call_rem",
        tool: "create_reminder",
        input: { title: "Chase the invoice", due_at: null },
      }),
      said("Fine, I've left it.")
    )
    await turns(words(a.phone, from, wamid(), "The invoice is late."), model)
    const [ask] = interactiveSent()
    const no = (ask as Buttons).action.buttons[1]?.reply as { id: string }
    const conversationId = (await linkOf(from)).conversation_id as string
    graph.length = 0
    expect(await turns(tapped(a.phone, from, no.id, "Not now"), model)).toEqual(
      ["ran"]
    )
    const rows = await kit.withOrg({ orgId: a.orgId }, (db) =>
      db
        .select()
        .from(reminders)
        .where(eq(reminders.conversationId, conversationId))
    )
    expect(rows).toHaveLength(0)
    expect(textsSent()).toEqual(["Fine, I've left it."])
  })

  it("sends a step with two cards to the web instead of buttons", async () => {
    const from = sender()
    await link(a, from)
    const { model } = scripted(
      calling(
        "Two things to look at.",
        {
          id: "call_a",
          tool: "create_reminder",
          input: { title: "Call the supplier", due_at: null },
        },
        {
          id: "call_b",
          tool: "create_reminder",
          input: { title: "Order cloths", due_at: null },
        }
      )
    )
    graph.length = 0
    await turns(words(a.phone, from, wamid(), "Supplier and cloths."), model)
    const conversationId = (await linkOf(from)).conversation_id
    const [cta] = interactiveSent()
    expect(cta).toEqual({
      type: "cta_url",
      body: { text: "Two things to look at." },
      action: {
        name: "cta_url",
        parameters: {
          display_text: "Open Reme to approve",
          url: `${ORIGIN}/app/c/${conversationId}`,
        },
      },
    })
  })

  it("puts where the owner writes from in the turn's context, and logs it", async () => {
    const from = sender()
    await link(a, from)
    const { model, prompts } = scripted(said("Hello."))
    await turns(words(a.phone, from, wamid(), "Hi there."), model)
    expect(prompts[0]).toContain("The owner is writing from WhatsApp.")
    expect(prompts[0]).toContain("unless the owner asks for it")
    const [row] = await admin<{ text: string }[]>`
      select payload->>'text' as text from events
      where session_id = ${(await linkOf(from)).conversation_id as string} and type = 'cos.context'`
    expect(row?.text).toContain("The owner is writing from WhatsApp.")
  })

  it("ignores a list pick and a tap on a button we never sent", async () => {
    const from = sender()
    await link(a, from)
    for (const raw of [
      tapped(a.phone, from, "other:thing", "Hmm"),
      tapped(a.phone, from, "ch:0", "x").replaceAll(
        "button_reply",
        "list_reply"
      ),
    ]) {
      jobs.length = 0
      expect((await post(raw)).status).toBe(200)
      expect(jobs).toEqual([])
    }
    const waiting =
      await admin`select 1 from channel_inbound where link_id = ${(await linkOf(from)).id}`
    expect(waiting).toHaveLength(0)
  })

  it("starts a fresh conversation on new, once per message", async () => {
    const from = sender()
    await link(a, from)
    const { model } = scripted(said("Hello."), said("Hello again."))
    await turns(words(a.phone, from, wamid(), "Hi."), model)
    const first = (await linkOf(from)).conversation_id
    expect(first).not.toBeNull()

    graph.length = 0
    jobs.length = 0
    const word = wamid()
    expect((await post(words(a.phone, from, word, "*new*"))).status).toBe(200)
    expect(jobs).toEqual([])
    expect((await linkOf(from)).conversation_id).toBeNull()
    expect(textsSent()).toEqual(["Started a new conversation."])

    await turns(words(a.phone, from, wamid(), "Hi again."), model)
    const second = (await linkOf(from)).conversation_id
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)

    graph.length = 0
    expect((await post(words(a.phone, from, word, "*new*"))).status).toBe(200)
    expect((await linkOf(from)).conversation_id).toBe(second)
    expect(graph).toEqual([])
  })

  it("ends the link on stop and says goodbye", async () => {
    const from = sender()
    await link(a, from)
    graph.length = 0
    jobs.length = 0
    expect((await post(words(a.phone, from, wamid(), "stop"))).status).toBe(200)
    expect(jobs).toEqual([])
    expect((await linkOf(from)).revoked_at).not.toBeNull()
    expect(textsSent()).toEqual([`Disconnected from ${a.name}.`])
    graph.length = 0
    expect((await post(words(a.phone, from, wamid(), "Hello?"))).status).toBe(
      200
    )
    expect(jobs).toEqual([])
    expect(graph).toEqual([])
  })

  describe("when the owner disconnects from the web", () => {
    const disconnect = async (id: string) => {
      const response = await a.call(
        stubOrchestrator(),
        `/channels/links/${id}`,
        {
          method: "DELETE",
          headers: { "idempotency-key": crypto.randomUUID() },
          bindings: { WHATSAPP_ENABLED: "1", CHANNEL_TOKEN_KEY: TOKEN_KEY },
        }
      )
      expect(response.status).toBe(204)
    }

    it("says goodbye while the 24-hour window is open", async () => {
      const from = sender()
      await link(a, from)
      await admin`update channel_links set last_inbound_at = now() - interval '23 hours' where external_id = ${from}`
      graph.length = 0
      await disconnect((await linkOf(from)).id)
      expect(graph.map((g) => g.body.to)).toEqual([from])
      expect(textsSent()).toEqual([`Disconnected from ${a.name}.`])
      expect((await linkOf(from)).revoked_at).not.toBeNull()
    })

    it("says nothing once the window has closed, or when they never wrote", async () => {
      const closed = sender()
      const silent = sender()
      await link(a, closed)
      await link(a, silent)
      await admin`update channel_links set last_inbound_at = now() - interval '25 hours' where external_id = ${closed}`
      graph.length = 0
      await disconnect((await linkOf(closed)).id)
      await disconnect((await linkOf(silent)).id)
      expect(graph).toEqual([])
      expect((await linkOf(closed)).revoked_at).not.toBeNull()
      expect((await linkOf(silent)).revoked_at).not.toBeNull()
    })
  })
})
