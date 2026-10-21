import { replyToken } from "@workspace/contracts"
import {
  conversationMessages,
  conversations,
  eq,
  memberships,
  sql,
  type Tenancy,
  tenancy,
  users,
} from "@workspace/db"
import type { Header } from "postal-mime"
import { afterAll, describe, expect, it, vi } from "vitest"
import {
  authenticated,
  MAX_RAW_BYTES,
  receive,
  stripReply,
} from "../src/inbound-email.ts"
import { owner } from "./owner-fixture.ts"

const header = (key: string, value: string): Header => ({
  key,
  originalKey: key,
  value,
})
const results = (value: string) => header("authentication-results", value)

describe("authenticated", () => {
  it("accepts a DMARC pass for the From domain", () => {
    expect(
      authenticated(
        [
          results(
            "mx.cloudflare.net; dkim=pass header.d=gmail.com; dmarc=pass header.from=gmail.com policy.dmarc=none"
          ),
        ],
        "gmail.com"
      )
    ).toBe(true)
  })

  it("accepts an aligned DKIM or SPF pass when the domain publishes no DMARC", () => {
    const dkim =
      "mx.cloudflare.net; dkim=pass header.d=example.co.uk; dmarc=none"
    const spf =
      "mx.cloudflare.net; spf=pass (mx.cloudflare.net: ok) smtp.mailfrom=owner@mail.example.co.uk; dmarc=none"
    expect(authenticated([results(dkim)], "mail.example.co.uk")).toBe(true)
    expect(authenticated([results(spf)], "mail.example.co.uk")).toBe(true)
  })

  it("reads the ARC copy Email Routing writes", () => {
    expect(
      authenticated(
        [
          header(
            "arc-authentication-results",
            "i=1; mx.cloudflare.net; dmarc=pass header.from=example.com; spf=pass smtp.mailfrom=example.com"
          ),
        ],
        "example.com"
      )
    ).toBe(true)
  })

  it("refuses a pass for another domain", () => {
    // Signed by the attacker's own domain, claiming the owner's address.
    expect(
      authenticated(
        [
          results(
            "mx.cloudflare.net; dkim=pass header.d=attacker.test; spf=pass smtp.mailfrom=bounce@attacker.test; dmarc=fail header.from=gmail.com"
          ),
        ],
        "gmail.com"
      )
    ).toBe(false)
    expect(
      authenticated(
        [results("mx.cloudflare.net; dkim=pass header.d=attacker.test")],
        "gmail.com"
      )
    ).toBe(false)
  })

  it("refuses an explicit DMARC failure even beside an aligned pass", () => {
    expect(
      authenticated(
        [
          results(
            "mx.cloudflare.net; spf=pass smtp.mailfrom=example.com; dmarc=fail header.from=example.com"
          ),
        ],
        "example.com"
      )
    ).toBe(false)
  })

  it("believes only the topmost header, and only when it is Email Routing's", () => {
    const planted = results(
      "mx.cloudflare.net; dmarc=pass header.from=example.com"
    )
    const other = results(
      "mail.attacker.test; dmarc=pass header.from=example.com"
    )
    const ours = results(
      "mx.cloudflare.net; dkim=pass header.d=example.com; dmarc=pass header.from=example.com"
    )
    // The real one on top, as the receiving server writes it.
    expect(authenticated([ours, planted], "example.com")).toBe(true)
    expect(
      authenticated(
        [
          results("mx.cloudflare.net; dmarc=fail header.from=example.com"),
          planted,
        ],
        "example.com"
      )
    ).toBe(false)
    // Nothing the sender writes can sit above the header written on receipt,
    // so a planted copy is only ever below something else, and is not read.
    expect(authenticated([other, planted], "example.com")).toBe(false)
    expect(authenticated([other, ours], "example.com")).toBe(false)
  })

  it("reads the ARC copy when that is all there is, from its topmost and highest instance", () => {
    const arc = (value: string) => header("arc-authentication-results", value)
    const pass = "mx.cloudflare.net; dmarc=pass header.from=example.com"
    expect(authenticated([arc(`i=1; ${pass}`)], "example.com")).toBe(true)
    expect(
      authenticated([arc(`i=1; ${pass}`), arc(`i=2; ${pass}`)], "example.com")
    ).toBe(false)
    // The sender's own provider sealed it first; Email Routing's is above.
    expect(
      authenticated(
        [
          arc(`i=2; ${pass}`),
          arc("i=1; mx.google.com; dmarc=pass header.from=example.com"),
        ],
        "example.com"
      )
    ).toBe(true)
  })

  it("lets a planted Authentication-Results answer for nothing Cloudflare wrote as ARC", () => {
    const arc = (value: string) => header("arc-authentication-results", value)
    const planted = results(
      "mx.cloudflare.net; dmarc=pass header.from=example.com"
    )
    // Cloudflare's ARC result is a failure, or says nothing of the domain.
    expect(
      authenticated(
        [
          planted,
          arc("i=1; mx.cloudflare.net; dmarc=fail header.from=example.com"),
        ],
        "example.com"
      )
    ).toBe(false)
    expect(
      authenticated(
        [planted, arc("i=1; mx.cloudflare.net; spf=fail smtp.mailfrom=x.test")],
        "example.com"
      )
    ).toBe(false)
    // An untrusted Authentication-Results does not hide a good ARC result.
    expect(
      authenticated(
        [
          results("mail.attacker.test; dmarc=fail header.from=example.com"),
          arc("i=1; mx.cloudflare.net; dmarc=pass header.from=example.com"),
        ],
        "example.com"
      )
    ).toBe(true)
  })

  it("fails closed with no results, or none it can read", () => {
    expect(authenticated([], "example.com")).toBe(false)
    expect(authenticated([results("mx.cloudflare.net")], "example.com")).toBe(
      false
    )
    expect(authenticated([results("???;;;")], "example.com")).toBe(false)
  })
})

describe("stripReply", () => {
  it("keeps the words above a Gmail attribution", () => {
    expect(
      stripReply(
        "Thursday works.\n\nOn Mon, 19 Oct 2026 at 09:00, Reme <hello@remeai.co.uk> wrote:\n> Reminder: call the plumber\n> at ten"
      )
    ).toBe("Thursday works.")
  })

  it("handles an attribution wrapped over two lines and other languages", () => {
    expect(
      stripReply(
        "Ja, gerne.\r\n\r\nAm 19.10.2026 um 09:00 schrieb Reme\r\n<hello@remeai.co.uk>:\r\n> Erinnerung"
      )
    ).toBe("Ja, gerne.")
    expect(
      stripReply("Oui.\n\nLe 19 oct. 2026 à 09:00, Reme a écrit :\n> Rappel")
    ).toBe("Oui.")
  })

  it("cuts an Outlook original-message line and its header block", () => {
    expect(
      stripReply(
        "Fine by me.\n\n-----Original Message-----\nFrom: Reme\nSent: Monday\nSubject: Reminder"
      )
    ).toBe("Fine by me.")
    expect(
      stripReply(
        "Fine by me.\n\nFrom: Reme <hello@remeai.co.uk>\nSent: Monday, 19 October 2026 09:00\nTo: Owner\nSubject: Reminder"
      )
    ).toBe("Fine by me.")
  })

  it("drops quoted lines but keeps inline answers beneath them", () => {
    expect(stripReply("> Call at ten?\nYes.\n> Bring the keys?\nNo.")).toBe(
      "Yes.\nNo."
    )
  })

  it("cuts a signature after the delimiter and a trailing device line", () => {
    expect(stripReply("Do it.\n\n-- \nJo Smith\n07700 900000")).toBe("Do it.")
    expect(stripReply("Do it.\n\nSent from my iPhone")).toBe("Do it.")
    expect(stripReply("Sent from my iPhone is a good phone.\n\nDo it.")).toBe(
      "Sent from my iPhone is a good phone.\n\nDo it."
    )
  })

  it("leaves nothing when the reply was only a quotation", () => {
    expect(stripReply("On Mon, 19 Oct 2026, Reme wrote:\n> Reminder")).toBe("")
    expect(stripReply("> Reminder\n> again")).toBe("")
  })

  it("keeps ordinary text that merely mentions a marker word", () => {
    expect(stripReply("On Friday I wrote the cheque.\nThanks.")).toBe(
      "On Friday I wrote the cheque.\nThanks."
    )
  })
})

const url = process.env.DATABASE_URL
const KEY = "reply-key-for-tests-0123456789ab"
const DOMAIN = "reply.example.invalid"

describe.skipIf(!url)("receive, against a database", () => {
  const kit: Tenancy = tenancy(url as string)
  afterAll(() => kit.close())

  /** An org with its owner, and a conversation whose tail is `tail`. */
  async function setup(tail: Record<string, unknown>[] = []) {
    const who = await owner(kit, url as string, "mail")
    const conversationId = crypto.randomUUID()
    const [row] = await kit.withOrg({ orgId: who.orgId }, async (db) => {
      await db.insert(conversations).values({
        id: conversationId,
        orgId: who.orgId,
        kind: "assistant",
        createdByStaffId: who.chiefId,
      })
      await db.insert(conversationMessages).values({
        conversationId,
        id: "tail_1",
        orgId: who.orgId,
        format: "ai-sdk/v6",
        content: { role: "assistant", parts: tail },
      })
      return db
        .select({ email: users.email })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(sql`${memberships.orgId} = ${who.orgId}`)
    })
    return { ...who, conversationId, email: (row?.email ?? "") as string }
  }

  const rows = (orgId: string, id: string) =>
    kit.withOrg({ orgId }, (db) =>
      db.execute<{ id: string; content: unknown }>(
        sql`select id, content from ${conversationMessages}
          where conversation_id = ${id} order by seq`
      )
    )

  const passing = (domain: string) =>
    `Authentication-Results: mx.cloudflare.net; dkim=pass header.d=${domain}; dmarc=pass header.from=${domain}`

  /** An inbound message as Email Routing hands it over. */
  function inbound(options: {
    token: string
    from: string
    auth?: string
    body?: string
    messageId?: string
    size?: number
  }) {
    const { token, from, body = "Move it to Friday." } = options
    const domain = from.split("@")[1] as string
    const mime = [
      options.auth ?? passing(domain),
      `From: Someone <${from}>`,
      `To: reply+${token}@${DOMAIN}`,
      "Subject: Re: Your reminder",
      `Message-ID: ${options.messageId ?? `<${crypto.randomUUID()}@mail.example>`}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
    ].join("\r\n")
    const setReject = vi.fn()
    const message = {
      from,
      to: `reply+${token}@${DOMAIN}`,
      headers: new Headers(),
      raw: new Response(mime).body,
      rawSize: options.size ?? mime.length,
      setReject,
    } as unknown as ForwardableEmailMessage
    return { message, setReject }
  }

  const env = {
    HYPERDRIVE: {} as Hyperdrive,
    REPLY_TOKEN_KEY: KEY,
    REPLY_MAILBOX: `reply@${DOMAIN}`,
  }
  const quiet = () =>
    vi.spyOn(console, "log").mockImplementation(() => undefined)

  it("posts a valid reply as the owner's message, with the quoted history cut, and logs no address or body", async () => {
    const log = quiet()
    const o = await setup()
    const token = await replyToken(KEY, o.orgId, o.conversationId)
    const { message, setReject } = inbound({
      token,
      from: o.email,
      body: [
        "Move it to Friday.",
        "",
        "On Mon, 19 Oct 2026 at 09:00 Reme <hello@remeai.co.uk> wrote:",
        "> Your reminder is due.",
      ].join("\r\n"),
    })
    await receive(message, env, kit)
    expect(setReject).not.toHaveBeenCalled()
    const stored = await rows(o.orgId, o.conversationId)
    expect(stored).toHaveLength(2)
    expect(stored[1]?.id).toMatch(/^eml_/)
    expect(stored[1]?.content).toEqual({
      role: "user",
      parts: [{ type: "text", text: "Move it to Friday." }],
    })
    const lines = log.mock.calls.map((c) => String(c[0]))
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      code: "inbound_email",
      outcome: "accepted",
      reason: "posted",
    })
    expect(lines[0]).not.toContain(o.email)
    expect(lines[0]).not.toContain("Friday")
    log.mockRestore()
  })

  it("posts a redelivered mail once", async () => {
    const log = quiet()
    const o = await setup()
    const token = await replyToken(KEY, o.orgId, o.conversationId)
    for (let i = 0; i < 2; i++) {
      const { message, setReject } = inbound({
        token,
        from: o.email,
        messageId: "<same@mail.example>",
      })
      await receive(message, env, kit)
      expect(setReject).not.toHaveBeenCalled()
    }
    expect(await rows(o.orgId, o.conversationId)).toHaveLength(2)
    log.mockRestore()
  })

  it("posts nothing for a forged token, a token for a conversation the org lacks, or a wrong domain", async () => {
    const log = quiet()
    const o = await setup()
    const other = await setup()
    const refused = async (token: string, domain = DOMAIN) => {
      const { message, setReject } = inbound({ token, from: o.email })
      Object.assign(message, { to: `reply+${token}@${domain}` })
      await receive(message, env, kit)
      expect(setReject).toHaveBeenCalledTimes(1)
    }
    await refused(
      await replyToken(
        "another-key-0123456789abcdefghij",
        o.orgId,
        o.conversationId
      )
    )
    await refused("A".repeat(56))
    await refused("short")
    // Signed by us, but naming a conversation that belongs to another org.
    await refused(await replyToken(KEY, o.orgId, other.conversationId))
    await refused(
      await replyToken(KEY, o.orgId, o.conversationId),
      "elsewhere.invalid"
    )
    expect(await rows(o.orgId, o.conversationId)).toHaveLength(1)
    expect(await rows(other.orgId, other.conversationId)).toHaveLength(1)
    log.mockRestore()
  })

  it("posts nothing from a sender who is not an owner of the org", async () => {
    const log = quiet()
    const o = await setup()
    const token = await replyToken(KEY, o.orgId, o.conversationId)
    const { message, setReject } = inbound({
      token,
      from: "stranger@elsewhere.example",
    })
    await receive(message, env, kit)
    expect(setReject).toHaveBeenCalledTimes(1)
    expect(await rows(o.orgId, o.conversationId)).toHaveLength(1)
    log.mockRestore()
  })

  it("posts nothing when authentication fails: a spoofed owner address, a planted header, no header", async () => {
    const log = quiet()
    const o = await setup()
    const token = await replyToken(KEY, o.orgId, o.conversationId)
    const domain = o.email.split("@")[1] as string
    for (const auth of [
      // The owner's address, signed by the attacker's own domain.
      `Authentication-Results: mx.cloudflare.net; dkim=pass header.d=attacker.example; dmarc=fail header.from=${domain}`,
      // A pass the sender wrote for themselves, under another server's name.
      `Authentication-Results: mail.attacker.example; dmarc=pass header.from=${domain}`,
      "X-Nothing: here",
    ]) {
      const { message, setReject } = inbound({ token, from: o.email, auth })
      await receive(message, env, kit)
      expect(setReject).toHaveBeenCalledTimes(1)
    }
    expect(await rows(o.orgId, o.conversationId)).toHaveLength(1)
    log.mockRestore()
  })

  it("posts nothing over the size cap, and does not read the body", async () => {
    const log = quiet()
    const o = await setup()
    const token = await replyToken(KEY, o.orgId, o.conversationId)
    const { message, setReject } = inbound({
      token,
      from: o.email,
      size: MAX_RAW_BYTES + 1,
    })
    await receive(message, env, kit)
    expect(setReject).toHaveBeenCalledTimes(1)
    expect(message.raw.locked).toBe(false)
    expect(await rows(o.orgId, o.conversationId)).toHaveLength(1)
    log.mockRestore()
  })

  it("approves nothing: an emailed yes beside an open card is refused and the card stays open", async () => {
    const log = quiet()
    const card = [
      { type: "step-start" },
      {
        type: "tool-ask_choice",
        toolCallId: "call_1",
        state: "approval-requested",
        input: { key: "manual_builder" },
      },
    ]
    const o = await setup(card)
    const token = await replyToken(KEY, o.orgId, o.conversationId)
    const { message, setReject } = inbound({
      token,
      from: o.email,
      body: "yes go ahead",
    })
    await receive(message, env, kit)
    expect(setReject).toHaveBeenCalledTimes(1)
    const stored = await rows(o.orgId, o.conversationId)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.content).toEqual({ role: "assistant", parts: card })
    log.mockRestore()
  })
})
