import { ErrorEnvelope, WhatsAppAccount } from "@workspace/contracts"
import { type Tenancy, tenancy, whatsappAccounts } from "@workspace/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { openToken, sealToken } from "../src/channels/token.ts"
import { type Owner, owner, stubOrchestrator } from "./owner-fixture.ts"
import { stubJwksFetch } from "./sealed-session.ts"

/**
 * Embedded Signup's server half on a live connection, with the Graph answers
 * written out as Meta documents them (never a live call): the code exchange,
 * the number read, register, subscribed_apps.
 */

const url = process.env.DATABASE_URL
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
const BINDINGS = {
  WHATSAPP_ENABLED: "1",
  WHATSAPP_APP_ID: "100000000000001",
  WHATSAPP_APP_SECRET: "fixture",
  WHATSAPP_SIGNUP_CONFIG_ID: "200000000000002",
  CHANNEL_TOKEN_KEY: KEY,
}
const TOKEN = "EAAB-test"

type Step = "exchange" | "phone" | "register" | "subscribe"
const RECORDED = {
  exchange: { access_token: TOKEN, token_type: "bearer" },
  phone: {
    verified_name: "Sparkle Cleaning",
    display_phone_number: "+44 7700 900123",
    is_on_biz_app: false,
    id: "x",
  },
  register: { success: true },
  subscribe: { success: true },
}
const DENIED = {
  error: {
    message: "Invalid OAuth access token.",
    type: "OAuthException",
    code: 190,
    fbtrace_id: "A1b2C3",
  },
}

const keyed = (body: unknown) => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": crypto.randomUUID(),
  },
  body: JSON.stringify(body),
})
const meta = () => String(Math.floor(Math.random() * 9e11) + 1e12)

describe.skipIf(!url)("Embedded Signup, on a live connection", () => {
  const kit: Tenancy = tenancy(url as string, { max: 3 })
  const jwks = stubJwksFetch()
  const realFetch = globalThis.fetch
  let seen: { step: Step; init: RequestInit; url: URL }[] = []
  let ok: Owner
  let coex: Owner
  let bad: Owner
  let held: Owner

  /** Answers every Graph call from `RECORDED`, bar the steps `over` says to deny or change. */
  function graph(over: Partial<Record<Step, object | "denied">> = {}) {
    seen = []
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const asked = new URL(
        typeof input === "string" ? input : input.toString()
      )
      if (asked.host !== "graph.facebook.com") return jwks(input)
      const step: Step = asked.pathname.includes("oauth/access_token")
        ? "exchange"
        : asked.pathname.endsWith("/register")
          ? "register"
          : asked.pathname.endsWith("/subscribed_apps")
            ? "subscribe"
            : "phone"
      seen.push({ step, init: init ?? {}, url: asked })
      const reply = over[step] ?? RECORDED[step]
      return reply === "denied"
        ? Response.json(DENIED, { status: 400 })
        : Response.json(reply)
    }) as typeof fetch
  }

  const call = (
    as: Owner,
    body: unknown,
    bindings: Record<string, unknown> = BINDINGS
  ) =>
    as.call(stubOrchestrator(), "/channels/whatsapp/signup", {
      ...keyed(body),
      bindings,
    })
  const stored = (as: Owner) =>
    kit.withOrg({ orgId: as.orgId }, (db) => db.select().from(whatsappAccounts))
  const popup = () => ({
    code: "AQB-code-fixture",
    waba_id: meta(),
    phone_number_id: meta(),
  })

  beforeAll(async () => {
    globalThis.fetch = jwks
    ok = await owner(kit, url as string, "sig-ok")
    coex = await owner(kit, url as string, "sig-coex")
    bad = await owner(kit, url as string, "sig-bad")
    held = await owner(kit, url as string, "sig-held")
  }, 90_000)
  afterAll(async () => {
    globalThis.fetch = realFetch
    await kit.close()
  })

  it("is a 404 with the gate off and a 503 until the configuration exists", async () => {
    graph()
    expect((await call(ok, popup(), {})).status).toBe(404)
    const unset = { ...BINDINGS, WHATSAPP_SIGNUP_CONFIG_ID: "" }
    const response = await call(ok, popup(), unset)
    expect(response.status).toBe(503)
    expect(ErrorEnvelope.parse(await response.json()).code).toBe(
      "channels.signup_unavailable"
    )
    expect(seen).toEqual([])
  })

  it("tells the popup the app and configuration ids, and nothing secret", async () => {
    const response = await ok.call(
      stubOrchestrator(),
      "/channels/whatsapp/signup",
      {
        bindings: BINDINGS,
      }
    )
    expect(await response.json()).toEqual({
      app_id: BINDINGS.WHATSAPP_APP_ID,
      config_id: BINDINGS.WHATSAPP_SIGNUP_CONFIG_ID,
    })
  })

  it("refuses a body with anything beyond the popup's three fields", async () => {
    graph()
    const response = await call(ok, { ...popup(), org_id: crypto.randomUUID() })
    expect(response.status).toBe(400)
    expect(seen).toEqual([])
  })

  it("exchanges, registers, subscribes and stores the account with the token sealed", async () => {
    graph()
    const body = popup()
    const response = await call(ok, body)
    expect(response.status).toBe(201)
    const text = await response.text()
    expect(text).not.toContain(TOKEN)
    expect(WhatsAppAccount.parse(JSON.parse(text))).toEqual({
      display_number: "+447700900123",
      display_name: "Sparkle Cleaning",
      source: "connected",
      coexistence: false,
      status: "active",
    })

    expect(seen.map((s) => s.step)).toEqual([
      "exchange",
      "phone",
      "register",
      "subscribe",
    ])
    const [exchange, phone, register, subscribe] = seen
    expect(exchange?.url.searchParams.get("code")).toBe(body.code)
    expect(exchange?.url.searchParams.get("client_id")).toBe(
      BINDINGS.WHATSAPP_APP_ID
    )
    expect(phone?.url.pathname).toContain(`/${body.phone_number_id}`)
    expect(subscribe?.url.pathname).toContain(
      `/${body.waba_id}/subscribed_apps`
    )
    for (const graphCall of [phone, register, subscribe]) {
      expect(new Headers(graphCall?.init.headers).get("authorization")).toBe(
        `Bearer ${TOKEN}`
      )
    }
    const sent = JSON.parse(register?.init.body as string)
    expect(sent).toEqual({
      messaging_product: "whatsapp",
      pin: expect.stringMatching(/^\d{6}$/),
    })

    const [row] = await stored(ok)
    expect(row?.tokenCiphertext).not.toContain(TOKEN)
    expect(
      await openToken(BINDINGS, ok.orgId, row?.tokenCiphertext as string)
    ).toBe(TOKEN)
    expect(row?.wabaId).toBe(body.waba_id)
  })

  it("answers the same popup result sent twice with the account and no new Meta call", async () => {
    const [row] = await stored(ok)
    graph()
    const response = await call(ok, {
      code: "AQB-second-code",
      waba_id: row?.wabaId,
      phone_number_id: row?.phoneNumberId,
    })
    expect(response.status).toBe(200)
    expect(seen).toEqual([])
    expect(await stored(ok)).toHaveLength(1)
  })

  it("does not register a number already on the WhatsApp Business app", async () => {
    graph({ phone: { ...RECORDED.phone, is_on_biz_app: true } })
    const response = await call(coex, popup())
    expect(response.status).toBe(201)
    expect(WhatsAppAccount.parse(await response.json()).coexistence).toBe(true)
    expect(seen.map((s) => s.step)).toEqual(["exchange", "phone", "subscribe"])
  })

  it("stores nothing when Meta refuses the code, the number or the subscription", async () => {
    for (const [step, after] of [
      ["exchange", ["exchange"]],
      ["phone", ["exchange", "phone"]],
      ["register", ["exchange", "phone", "register"]],
      ["subscribe", ["exchange", "phone", "register", "subscribe"]],
    ] as const) {
      graph({ [step]: "denied" })
      const response = await call(bad, popup())
      expect(response.status).toBe(502)
      expect(ErrorEnvelope.parse(await response.json()).code).toBe(
        "channels.signup_failed"
      )
      expect(seen.map((s) => s.step)).toEqual(after)
      expect(await stored(bad)).toEqual([])
    }
  })

  it("refuses a number another org holds before it asks Meta anything", async () => {
    const phoneId = meta()
    await kit.withOrg({ orgId: held.orgId }, async (db) =>
      db.insert(whatsappAccounts).values({
        orgId: held.orgId,
        wabaId: meta(),
        phoneNumberId: phoneId,
        displayNumber: `+4477${phoneId.slice(-8)}`,
        displayName: "Held Cleaning",
        tokenCiphertext: await sealToken(BINDINGS, held.orgId, "held-token"),
        source: "connected",
        status: "active",
      })
    )
    graph()
    const response = await call(bad, {
      code: "AQB-code-fixture",
      waba_id: meta(),
      phone_number_id: phoneId,
    })
    expect(response.status).toBe(409)
    expect(ErrorEnvelope.parse(await response.json()).code).toBe(
      "channels.number_taken"
    )
    expect(seen).toEqual([])
    expect(await stored(bad)).toEqual([])
    expect((await stored(held))[0]?.displayName).toBe("Held Cleaning")
  })

  it("refuses a second number for an org that has one", async () => {
    graph()
    const response = await call(held, popup())
    expect(response.status).toBe(409)
    expect(ErrorEnvelope.parse(await response.json()).code).toBe(
      "channels.account_exists"
    )
    expect(seen).toEqual([])
  })
})
