import { type DomainRegistration, SITE_HEADER } from "@workspace/contracts"
import {
  conversationMessages,
  deployments,
  domains,
  eq,
  events,
  readTasks,
  searchConnections,
  sql,
} from "@workspace/db"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"
import {
  abandonUnpaid,
  boughtElsewhere,
  buy,
  buyElsewhere,
  captureRegistered,
  checkoutSession,
  elsewhereId,
  find,
  finishSandbox,
  followUpElsewhere,
  heldDetails,
  isRegistered,
  lookElsewhere,
  MAX_OPEN_PURCHASES,
  paymentEvent,
  registrarPhone,
  serveBought,
  startRegistration,
  subscribeRenewal,
} from "../src/domain-buy.ts"
import {
  activateDomain,
  postStatus,
  remove,
  revokeDomains,
  type Say,
  served,
  sweepDomains,
} from "../src/domain-flow.ts"
import { chatTexts, openChat } from "./chat.ts"
import {
  ACCOUNT,
  CHECK_SANDBOX,
  EXTENSION_CO_UK,
  EXTENSION_COM,
  envelope,
  INVOICE,
  LIVE,
  NOT_FOUND,
  PI,
  REG_PENDING,
  REGISTRATION,
  SANDBOX,
  STRIPE_MISSING,
  SUBSCRIPTION,
  WORKER_DOMAIN,
  ZONE,
} from "./fixtures/registrar.ts"
import { kit, previewed, type storage, workflowEnv } from "./site.ts"

vi.mock("../src/container.ts", () => ({
  RemeSandbox: class {},
  SandboxEgress: class {},
  SandboxPool: class {},
}))
vi.mock("../src/sandbox.ts", () => ({}))
vi.mock("../src/agents/developer.ts", () => ({ Developer: {} }))

// The registry's answer for a name bought elsewhere, and the connect it
// starts, whose own tests are in domain-flow.test.ts.
const rdap = vi.hoisted(() => ({
  registered: new Set<string>(),
  /** Endings with no RDAP server, which fall back on DNS. */
  unlisted: new Set<string>(),
  /** Names DNS delegates as a zone of their own. */
  zones: new Set<string>(),
}))
vi.mock("../src/rdap.ts", () => ({
  rdapLookup: async (name: string) =>
    rdap.unlisted.has(name.slice(name.indexOf(".") + 1))
      ? null
      : { registered: rdap.registered.has(name) },
}))
vi.mock("../src/domains.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/domains.ts")>()
  return {
    ...real,
    zoneApex: async (name: string) => {
      if (rdap.zones.has(name)) return { apex: name, missing: false }
      throw new real.DomainError("domain.not_found")
    },
  }
})
vi.mock("../src/domain-flow.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/domain-flow.ts")>()),
  connect: async (_e: unknown, _k: unknown, _o: unknown, body: unknown) => ({
    status: 201,
    output: { outcome: "connecting", method: "records", email_affected: false },
    body,
  }),
}))

/**
 * The buy path's routes and step bodies against a real database, with
 * Cloudflare's registrar, zones and Workers Custom Domains and Stripe stood
 * in for from the recorded and spec-shaped answers in fixtures/registrar.ts.
 * Skipped without DATABASE_URL, like the connect suite.
 */

const url = process.env.DATABASE_URL
const CF = "https://api.cloudflare.com/client/v4"
const STRIPE = "https://api.stripe.com/v1"

const priced = (name: string, cost = "10.46") => ({
  name,
  registrable: true,
  tier: "standard",
  pricing: { currency: "USD", registration_cost: cost, renewal_cost: cost },
})
const taken = (name: string) => ({
  name,
  registrable: false,
  tier: "standard",
  reason: "domain_unavailable",
})
const unsupported = (name: string) => ({
  name,
  registrable: false,
  tier: "standard",
  reason: "extension_not_supported_via_api",
})

type Net = {
  /** `domain-check` answers by name; anything unlisted is taken. */
  checks: Record<string, unknown>
  registered: Set<string>
  /** The names `domain-search` suggests. */
  suggests?: string[]
  /** The site id the router's edge probe names, once a test has a site. */
  site?: string
  /** The expiry the registrar reports for a registered name. */
  expires?: string
  pi: Record<string, unknown>
  calls: Array<{ method: string; url: string; body: string }>
}

/** Cloudflare and Stripe, stateful enough for a purchase to run through. */
function stubNet(live: boolean, checks: Record<string, unknown> = {}): Net {
  const net: Net = {
    checks,
    registered: new Set(),
    pi: PI("requires_capture"),
    calls: [],
  }
  const base = live ? LIVE : SANDBOX
  let sub = SUBSCRIPTION
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const href = String(input)
      const method = init?.method ?? "GET"
      const body = String(init?.body ?? "")
      net.calls.push({ method, url: href, body })
      const json = (b: unknown, status = 200) => Response.json(b, { status })
      if (href === `${base}/domain-check`) {
        const { domains: names } = JSON.parse(body) as { domains: string[] }
        return json(
          envelope({
            domains: names.map((n) => net.checks[n] ?? taken(n)),
          })
        )
      }
      if (href.startsWith(`${base}/domain-search`))
        return json(
          envelope({ domains: (net.suggests ?? []).map((name) => ({ name })) })
        )
      if (href === `${base}/extensions/co.uk`)
        return json(live ? EXTENSION_CO_UK : NOT_FOUND, live ? 200 : 400)
      if (href.startsWith(`${base}/extensions/`)) return json(EXTENSION_COM)
      const reg = href.match(new RegExp(`^${base}/registrations/([^/]+)$`))
      if (reg?.[1] && method === "GET")
        return net.registered.has(reg[1])
          ? json(REGISTRATION(reg[1], true, net.expires))
          : json(NOT_FOUND, 404)
      if (reg?.[1] && method === "PATCH") return json(REG_PENDING(reg[1]))
      const progress = href.match(
        new RegExp(`^${base}/registrations/([^/]+)/registration-status$`)
      )
      if (progress?.[1]) return json(REG_PENDING(progress[1]))
      if (href === `${base}/registrations` && method === "POST") {
        const { domain_name } = JSON.parse(body) as { domain_name: string }
        net.registered.add(domain_name)
        return json(REG_PENDING(domain_name), 202)
      }
      if (href.startsWith(`${CF}/zones?`)) return json(envelope([]))
      if (href === `${CF}/zones`) {
        const { name } = JSON.parse(body) as { name: string }
        return json(ZONE("z1", name))
      }
      if (href === `${CF}/accounts/${ACCOUNT}/workers/domains`) {
        const { hostname, zone_id } = JSON.parse(body) as {
          hostname: string
          zone_id: string
        }
        return json(WORKER_DOMAIN(hostname, zone_id))
      }
      if (href.startsWith(`${CF}/accounts/${ACCOUNT}/workers/domains/`))
        return json(envelope(null))
      if (href === `${STRIPE}/payment_intents/pi_123`) return json(net.pi)
      if (href === `${STRIPE}/payment_intents/pi_123/capture`) {
        net.pi = { ...net.pi, status: "succeeded" }
        return json(net.pi)
      }
      if (href === `${STRIPE}/payment_intents/pi_123/cancel`) {
        net.pi = { ...net.pi, status: "canceled" }
        return json(net.pi)
      }
      if (href.startsWith(`${STRIPE}/products/`))
        return json(STRIPE_MISSING, 404)
      if (href === `${STRIPE}/products`) return json({ id: "reme_domain_com" })
      if (href === `${STRIPE}/subscriptions`) return json(SUBSCRIPTION)
      if (href === `${STRIPE}/subscriptions/sub_123`) {
        if (method === "DELETE") sub = { ...sub, status: "canceled" }
        return json(sub)
      }
      if (href === `${STRIPE}/invoices/in_123`) return json(INVOICE)
      // The edge probe: the bought domain answers.
      if (href.startsWith("https://") && method === "GET")
        return new Response("ok", {
          headers: net.site ? { [SITE_HEADER]: net.site } : {},
        })
      throw new Error(`unexpected ${method} ${href}`)
    })
  )
  return net
}

function buyEnv(store: ReturnType<typeof storage>, live = false) {
  const created: Array<{ id: string; params: unknown }> = []
  const sent: unknown[] = []
  const holds: Array<{ id: string; params: unknown }> = []
  const woken: string[] = []
  const env = {
    ...workflowEnv(store).env,
    CF_DOMAINS_TOKEN: "token",
    CF_DOMAINS_ZONE_ID: "zone",
    CF_ACCOUNT_ID: ACCOUNT,
    REGISTRAR_API: live ? "registrar" : "registrar-sandbox",
    ROUTER_SERVICE: "reme-router",
    STRIPE_SECRET_KEY: "sk_test_x",
    DOMAINS: {
      create: async (instance: { id: string; params: unknown }) => {
        if (created.some((c) => c.id === instance.id))
          throw new Error("instance exists")
        created.push(instance)
        return instance
      },
      get: async () => ({
        sendEvent: async (e: unknown) => {
          sent.push(e)
        },
        terminate: async () => undefined,
      }),
    },
    ELSEWHERE: {
      create: async (instance: { id: string; params: unknown }) => {
        if (holds.some((c) => c.id === instance.id))
          throw new Error("instance exists")
        holds.push(instance)
        return instance
      },
      get: async (id: string) => {
        if (!holds.some((c) => c.id === id)) throw new Error("not found")
        return {
          status: async () => ({ status: "waiting" }),
          sendEvent: async (e: { type: string }) => {
            woken.push(`${id} ${e.type}`)
          },
        }
      },
    },
  } as unknown as Env
  return { env, created, sent, holds, woken }
}

async function published() {
  const site = await previewed()
  await kit.withOrg({ orgId: site.orgId }, (db) =>
    db.insert(deployments).values({
      orgId: site.orgId,
      siteId: site.orgId,
      revisionId: site.revisionId,
      configVersion: 1,
      kind: "rollback",
    })
  )
  return site
}

const rowOf = (orgId: string, name: string) =>
  kit.withOrg({ orgId }, async (db) => {
    const [row] = await db
      .select()
      .from(domains)
      .where(eq(domains.name, name))
      .orderBy(sql`${domains.createdAt} desc`)
      .limit(1)
    if (!row) throw new Error(`no row for ${name}`)
    return row
  })

const typesOf = (orgId: string, prefix: string) =>
  kit.withOrg({ orgId }, async (db) =>
    (
      await db
        .select({ type: events.type })
        .from(events)
        .where(sql`${events.type} like ${`${prefix}%`}`)
    ).map((e) => e.type)
  )

const unique = (tld = "com") =>
  `bright${crypto.randomUUID().slice(0, 8)}.${tld}`

const details = {
  registrant: {
    name: "Jane Smith",
    business_name: "BrightClean",
    email: "jane@example.com",
    phone: "+447700900123",
    address: {
      street: "12 Mill Lane",
      city: "Bristol",
      postal_code: "BS1 4AB",
      country_code: "GB",
    },
  },
}

/** A published org with an `awaiting_payment` purchase of a fresh `.com`. */
async function purchase(live = false) {
  const site = await published()
  const name = unique()
  const net = stubNet(live, { [name]: priced(name) })
  const setup = buyEnv(site.store, live)
  const bought = await buy(setup.env, kit, site.orgId, { name, ...details })
  expect(bought).toMatchObject({ status: 201 })
  const row = await rowOf(site.orgId, name)
  return { ...site, ...setup, name, net, row }
}

/** The purchase with its Checkout Session stored and its hold authorised. */
async function paid(live = false) {
  const p = await purchase(live)
  expect(
    await checkoutSession(p.env, kit, p.orgId, p.row.id, {
      session_id: "cs_1",
      customer: "cus_123",
      ...details,
    })
  ).toBeNull()
  p.net.pi = PI("requires_capture", { metadata: { domain_id: p.row.id } })
  expect(
    await paymentEvent(p.env, kit, p.orgId, p.row.id, {
      type: "paid",
      event_id: `evt_${crypto.randomUUID().slice(0, 8)}`,
      domain_id: p.row.id,
      checkout_session: "cs_1",
      payment_intent: "pi_123",
    })
  ).toBeNull()
  return p
}

afterEach(() => vi.unstubAllGlobals())
afterAll(() => kit.close())

describe("the registrar's phone form", () => {
  it("splits E.164 at the country code", () => {
    expect(registrarPhone("+447700900123")).toBe("+44.7700900123")
    expect(registrarPhone("+15555550142")).toBe("+1.5555550142")
    expect(registrarPhone("+353871234567")).toBe("+353.871234567")
    expect(registrarPhone("+79161234567")).toBe("+7.9161234567")
  })
})

describe.skipIf(!url)("buying a domain against a database", () => {
  it("offers only names the configured registrar sells: .co.uk live, not in the sandbox", async () => {
    const site = await published()
    const checks = Object.fromEntries(
      (
        CHECK_SANDBOX.result as { domains: Array<{ name: string }> }
      ).domains.map((d) => [d.name, d])
    )
    const sandboxChecks = {
      ...checks,
      "brightclean.co.uk": unsupported("brightclean.co.uk"),
      "brightclean.com": priced("brightclean.com"),
    }
    const asked = (net: Net) =>
      net.calls
        .filter((c) => c.url.endsWith("/domain-check"))
        .flatMap((c) => JSON.parse(c.body).domains as string[])
    const sandboxNet = stubNet(false, sandboxChecks)
    const { env } = buyEnv(site.store)
    const sandbox = await find(env, kit, site.orgId, {})
    // The sandbox is asked about .com only, and its rows show nothing else.
    expect(sandbox).toEqual({
      outcome: "found",
      rows: [
        {
          stem: "brightclean",
          why: "matches your business name",
          endings: { com: { state: "free", price_gbp_year: 12 } },
        },
      ],
    })
    expect(asked(sandboxNet).length).toBeGreaterThan(0)
    expect(asked(sandboxNet).every((n) => n.endsWith(".com"))).toBe(true)

    vi.unstubAllGlobals()
    const liveNet = stubNet(true, {
      "brightclean.co.uk": priced("brightclean.co.uk", "5.30"),
      "brightclean.uk": priced("brightclean.uk", "5.30"),
    })
    const live = await find(buyEnv(site.store, true).env, kit, site.orgId, {})
    expect(asked(liveNet).some((n) => n.endsWith(".net"))).toBe(false)
    // One row per stem, .com taken beside the free UK endings; a stem with
    // nothing free is left out.
    expect(live).toEqual({
      outcome: "found",
      rows: [
        {
          stem: "brightclean",
          why: "matches your business name",
          endings: {
            "co.uk": { state: "free", price_gbp_year: 8 },
            com: { state: "taken" },
            uk: { state: "free", price_gbp_year: 8 },
          },
        },
      ],
    })
    // The owner is picking: the address task's choose step waits on them.
    const [task] = await kit.withOrg({ orgId: site.orgId }, (db) =>
      readTasks(db)
    )
    expect(task?.steps.find((s) => s.step === "choose")).toMatchObject({
      state: "blocked",
      blocked_on: "owner_action",
      note: "picking a name",
    })
  })

  it("fills four rows from the registrar's suggestions for the business name, each its own reason", async () => {
    const site = await published()
    const suggests = [
      "brightcleanpro.com",
      "getbrightclean.com",
      "brightcleanhome.com",
      "brightcleanplus.com",
    ]
    const net = stubNet(false, {
      "brightclean.com": priced("brightclean.com"),
      ...Object.fromEntries(suggests.map((n) => [n, priced(n)])),
    })
    net.suggests = suggests
    const found = await find(buyEnv(site.store).env, kit, site.orgId, {})
    expect(
      net.calls.some((c) => c.url.includes("domain-search?q=BrightClean"))
    ).toBe(true)
    expect(found).toMatchObject({ outcome: "found" })
    const rows = (found as { rows: Array<{ stem: string; why: string }> }).rows
    expect(rows.map((r) => [r.stem, r.why])).toEqual([
      ["brightclean", "matches your business name"],
      ["brightcleanpro", "your name plus pro"],
      ["getbrightclean", "get before your name"],
      ["brightcleanhome", "your name plus home"],
    ])
  })

  it("refuses when nothing is free or over its cap, and when the registrar is down", async () => {
    const site = await published()
    stubNet(false, { "brightclean.com": priced("brightclean.com", "99.00") })
    const { env } = buyEnv(site.store)
    expect(await find(env, kit, site.orgId, {})).toMatchObject({
      refused: true,
      code: "domain.unavailable",
    })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 }))
    )
    expect(await find(env, kit, site.orgId, {})).toMatchObject({
      status: 503,
      code: "registrar.unavailable",
    })
  })

  it("opens a purchase: the price, the details and the sandbox flag on the row, and its Workflow started", async () => {
    const p = await purchase()
    expect(p.row).toMatchObject({
      state: "awaiting_payment",
      origin: "purchased",
      method: "purchased",
      primaryHost: p.name,
      price: { tld: "com", retail_gbp: 12, cost_usd: 10.46 },
      registrant: details,
      registration: { sandbox: true, years: 1, auto_renew: true },
    })
    expect(p.created).toEqual([
      {
        id: `domain-${p.row.id}`,
        params: { org_id: p.orgId, domain_id: p.row.id, buy: true },
      },
    ])
    // Asked again: the same row, refreshed, and no second Workflow.
    const again = await buy(p.env, kit, p.orgId, { name: p.name, ...details })
    expect(again).toMatchObject({
      status: 200,
      output: { outcome: "awaiting_payment", name: p.name, price_gbp: 12 },
    })
    expect(p.created).toHaveLength(1)
    expect(await typesOf(p.orgId, "domain.buy")).toEqual([
      "domain.buy_requested",
    ])
  })

  it("refuses a purchase it cannot take", async () => {
    const site = await published()
    const name = unique()
    stubNet(false, { [name]: priced(name, "13.00") })
    const { env } = buyEnv(site.store)
    const ask = (e: Env, body: unknown) => buy(e, kit, site.orgId, body)
    expect(
      await ask({ ...env, STRIPE_SECRET_KEY: undefined } as Env, {
        name,
        ...details,
      })
    ).toMatchObject({ code: "domain.buy_unavailable" })
    expect(await ask(env, { name, ...details })).toMatchObject({
      code: "domain.price_changed",
    })
    expect(await ask(env, { name: unique(), ...details })).toMatchObject({
      code: "domain.unavailable",
    })
    expect(await ask(env, { name: `book.${name}`, ...details })).toMatchObject({
      code: "domain.unavailable",
    })
    expect(await ask(env, { name })).toMatchObject({
      status: 400,
      code: "domain.registrant_invalid",
    })
  })

  it("asks .co.uk for who the registrant is in law, from Cloudflare's own schema", async () => {
    const site = await published()
    const name = unique("co.uk")
    stubNet(true, { [name]: priced(name, "5.30") })
    const { env } = buyEnv(site.store, true)
    expect(await buy(env, kit, site.orgId, { name, ...details })).toMatchObject(
      { status: 400, code: "domain.registrant_invalid" }
    )
    expect(
      await buy(env, kit, site.orgId, {
        name,
        ...details,
        registrant_type: "LTD",
      })
    ).toMatchObject({ status: 400, code: "domain.registrant_invalid" })
    expect(
      await buy(env, kit, site.orgId, {
        name,
        ...details,
        registrant_type: "STRA",
      })
    ).toMatchObject({ status: 201 })
  })

  it("holds a name from other orgs while unpaid, and caps an org's open purchases", async () => {
    const p = await purchase()
    const other = await published()
    expect(
      await buy(buyEnv(other.store).env, kit, other.orgId, {
        name: p.name,
        ...details,
      })
    ).toMatchObject({ code: "domain.unavailable" })

    for (let i = 1; i < MAX_OPEN_PURCHASES; i++) {
      const name = unique()
      p.net.checks[name] = priced(name)
      expect(
        await buy(p.env, kit, p.orgId, { name, ...details })
      ).toMatchObject({ status: 201 })
    }
    const one = unique()
    p.net.checks[one] = priced(one)
    expect(
      await buy(p.env, kit, p.orgId, { name: one, ...details })
    ).toMatchObject({ code: "domain.too_many_pending" })
  })

  it("stores the Checkout Session and the latest details, refusing details that do not suit", async () => {
    const p = await purchase()
    const body = { session_id: "cs_1", customer: "cus_123", ...details }
    expect(
      await checkoutSession(p.env, kit, p.orgId, p.row.id, body)
    ).toBeNull()
    const row = await rowOf(p.orgId, p.name)
    expect(row.stripe).toEqual({
      customer: "cus_123",
      checkout_session: "cs_1",
    })
    expect(
      await checkoutSession(p.env, kit, p.orgId, p.row.id, {
        session_id: "cs_1",
        customer: "cus_123",
      })
    ).toMatchObject({ status: 400, code: "domain.registrant_invalid" })
    expect(
      await checkoutSession(p.env, kit, p.orgId, "not-a-uuid", body)
    ).toMatchObject({ status: 404 })
    const other = await published()
    expect(
      await checkoutSession(p.env, kit, other.orgId, p.row.id, body)
    ).toMatchObject({ status: 404 })
  })

  it("takes a paid event once: verifying, the hold stored, the Workflow told", async () => {
    const p = await paid()
    const row = await rowOf(p.orgId, p.name)
    expect(row.state).toBe("verifying")
    expect(row.stripe).toMatchObject({ payment_intent: "pi_123" })
    expect(p.sent).toEqual([{ type: "paid", payload: {} }])
    const event = {
      type: "paid",
      event_id: "evt_same",
      domain_id: p.row.id,
      checkout_session: "cs_1",
      payment_intent: "pi_123",
    }
    await paymentEvent(p.env, kit, p.orgId, p.row.id, event)
    await paymentEvent(p.env, kit, p.orgId, p.row.id, event)
    expect(p.sent).toHaveLength(1)
    expect(await typesOf(p.orgId, "domain.stripe_event")).toHaveLength(2)
  })

  it("ignores a hold that does not match the price, and releases one for a purchase already closed", async () => {
    const p = await purchase()
    p.net.pi = PI("requires_capture", {
      amount: 100,
      metadata: { domain_id: p.row.id },
    })
    const event = (id: string) => ({
      type: "paid",
      event_id: id,
      domain_id: p.row.id,
      checkout_session: "cs_1",
      payment_intent: "pi_123",
    })
    await paymentEvent(p.env, kit, p.orgId, p.row.id, event("evt_low"))
    expect((await rowOf(p.orgId, p.name)).state).toBe("awaiting_payment")

    await abandonUnpaid(kit, p.orgId, p.row.id)
    p.net.pi = PI("requires_capture", { metadata: { domain_id: p.row.id } })
    await paymentEvent(p.env, kit, p.orgId, p.row.id, event("evt_late"))
    expect(p.net.pi).toMatchObject({ status: "canceled" })
  })

  it("abandons on its own session's expiry only, dropping the details", async () => {
    const p = await purchase()
    await checkoutSession(p.env, kit, p.orgId, p.row.id, {
      session_id: "cs_new",
      customer: "cus_123",
      ...details,
    })
    const expired = (session: string, id: string) =>
      paymentEvent(p.env, kit, p.orgId, p.row.id, {
        type: "expired",
        event_id: id,
        domain_id: p.row.id,
        checkout_session: session,
      })
    await expired("cs_old", "evt_old")
    expect((await rowOf(p.orgId, p.name)).state).toBe("awaiting_payment")
    await openChat(kit, p.orgId)
    await expired("cs_new", "evt_new")
    const row = await rowOf(p.orgId, p.name)
    expect(row).toMatchObject({
      state: "abandoned",
      registrant: null,
      registration: { outcome: "expired" },
    })
    // Said once: Stripe's resend and the Workflow's last round add nothing.
    await expired("cs_new", "evt_again")
    await abandonUnpaid(kit, p.orgId, p.row.id)
    expect(await chatTexts(kit, p.orgId)).toEqual([
      expect.stringContaining(`payment for ${p.name} ran out of time`),
    ])
    // Pay again opens the details and Pay page, which makes a fresh Checkout.
    const [message] = await kit.withOrg({ orgId: p.orgId }, (db) =>
      db
        .select({ content: conversationMessages.content })
        .from(conversationMessages)
    )
    expect(message?.content).toMatchObject({
      parts: expect.arrayContaining([
        {
          type: "data-button",
          data: {
            label: "Pay again",
            action: { kind: "pay", name: p.name },
          },
        },
      ]),
    })
  })

  it("registers in the sandbox with Cloudflare's phone form, captures, subscribes, and ends as a test", async () => {
    const p = await paid()
    const started = await startRegistration(p.env, kit, p.orgId, p.row.id)
    expect(started).toMatchObject({ gone: false, say: null })
    const post = p.net.calls.find(
      (c) => c.method === "POST" && c.url === `${SANDBOX}/registrations`
    )
    expect(JSON.parse(post?.body ?? "{}")).toMatchObject({
      domain_name: p.name,
      years: 1,
      auto_renew: true,
      contacts: {
        registrant: {
          phone: "+44.7700900123",
          postal_info: { address: { state: "Bristol" } },
        },
      },
    })

    expect(await captureRegistered(p.env, kit, p.orgId, p.row.id)).toBeNull()
    expect(p.net.pi).toMatchObject({ status: "succeeded" })
    let row = await rowOf(p.orgId, p.name)
    expect(row.registrant).toBeNull()
    expect(row.registration).toMatchObject({
      sandbox: true,
      status: "registered",
      expires_at: "2027-10-16T12:00:05Z",
    })

    await subscribeRenewal(p.env, kit, p.orgId, p.row.id)
    const sub = p.net.calls.find((c) => c.url === `${STRIPE}/subscriptions`)
    expect(new URLSearchParams(sub?.body).get("metadata[org_id]")).toBe(p.orgId)
    expect((await rowOf(p.orgId, p.name)).stripe).toMatchObject({
      subscription: "sub_123",
    })

    const said = await finishSandbox(p.env, kit, p.orgId, p.row.id)
    expect(said?.text).toMatch(/test purchase .*not live on the internet/)
    row = await rowOf(p.orgId, p.name)
    expect(row).toMatchObject({
      state: "removed",
      registration: { sandbox: true, outcome: "test_registered" },
    })
    // The name is free again for the next test.
    const again = await buy(p.env, kit, p.orgId, { name: p.name, ...details })
    expect(again).toMatchObject({ status: 201 })
  })

  it("releases the hold when the name was taken after the payment", async () => {
    const p = await paid()
    p.net.checks[p.name] = taken(p.name)
    const started = await startRegistration(p.env, kit, p.orgId, p.row.id)
    expect(started).toMatchObject({
      gone: false,
      say: { text: expect.stringMatching(/wasn't charged/) },
    })
    expect(p.net.pi).toMatchObject({ status: "canceled" })
    expect(await rowOf(p.orgId, p.name)).toMatchObject({
      state: "failed",
      registrant: null,
      registration: { outcome: "unavailable" },
    })
    expect(p.net.registered.size).toBe(0)
  })

  it("takes a retried start after the registration landed as started, keeping the hold", async () => {
    const p = await paid()
    await startRegistration(p.env, kit, p.orgId, p.row.id)
    // The step threw after Cloudflare took it; the name now checks as taken.
    p.net.checks[p.name] = taken(p.name)
    const again = await startRegistration(p.env, kit, p.orgId, p.row.id)
    expect(again).toMatchObject({ gone: false, say: null })
    expect(p.net.pi).toMatchObject({ status: "requires_capture" })
    expect((await rowOf(p.orgId, p.name)).state).toBe("verifying")
  })

  it("releases the hold when the cost rose over the cap", async () => {
    const p = await paid()
    p.net.checks[p.name] = priced(p.name, "12.51")
    await startRegistration(p.env, kit, p.orgId, p.row.id)
    expect(p.net.pi).toMatchObject({ status: "canceled" })
    expect((await rowOf(p.orgId, p.name)).registration).toMatchObject({
      outcome: "price_changed",
    })
  })

  it("raises an alert, not a failure, when the renewal cannot be set up", async () => {
    const p = await paid()
    await startRegistration(p.env, kit, p.orgId, p.row.id)
    await captureRegistered(p.env, kit, p.orgId, p.row.id)
    p.net.pi = { ...p.net.pi, payment_method: null }
    await subscribeRenewal(p.env, kit, p.orgId, p.row.id)
    expect(await typesOf(p.orgId, "alert.raised")).toEqual(["alert.raised"])
  })

  it("live: serves a bought domain through Workers Custom Domains, goes live, and a removal cancels its renewal and detaches them", async () => {
    const p = await paid(true)
    await startRegistration(p.env, kit, p.orgId, p.row.id)
    const said = await captureRegistered(p.env, kit, p.orgId, p.row.id)
    await subscribeRenewal(p.env, kit, p.orgId, p.row.id)
    expect(said?.text).toMatch(/registered.*jane@example\.com.*15 days/)
    expect((await rowOf(p.orgId, p.name)).registration).toMatchObject({
      sandbox: false,
      outcome: "registered",
    })
    expect(await serveBought(p.env, kit, p.orgId, p.row.id)).toBe(true)
    const attached = p.net.calls
      .filter((c) => c.url === `${CF}/accounts/${ACCOUNT}/workers/domains`)
      .map((c) => JSON.parse(c.body).hostname)
    expect(attached).toEqual([p.name, `www.${p.name}`])
    expect((await rowOf(p.orgId, p.name)).cfIds).toEqual({
      zone: "z1",
      worker_apex: `wd-${p.name}`,
      worker_www: `wd-www.${p.name}`,
    })

    // A purchase still being bought cannot be removed.
    expect(await remove(p.env, kit, p.orgId, p.name)).toMatchObject({
      code: "domain.purchase_in_progress",
    })

    // Not live until the router names the site: the 404 is not an answer.
    expect(await activateDomain(p.env, kit, p.orgId, p.row.id)).toBe(true)
    const unserved = await served(p.env, kit, p.orgId, p.row.id)
    expect(unserved.result).toMatchObject({ ready: false })
    expect(unserved.reading).not.toHaveProperty("tell")
    p.net.site = p.orgId
    // An org connected to Google hears that its new host is going there too.
    await kit.withOrg({ orgId: p.orgId }, (db) =>
      db
        .insert(searchConnections)
        .values({ orgId: p.orgId, state: "active", refreshToken: "v1.aXY.Y3Q" })
    )
    const live = await served(p.env, kit, p.orgId, p.row.id)
    expect(live.result).toMatchObject({ ready: true })
    expect(live.reading?.write).toEqual({ state: "done" })
    expect(unserved.reading).not.toHaveProperty("write")
    expect((await live.reading?.tell?.())?.text).toMatch(
      new RegExp(`^${p.name} is live.*adding it to your Google Search Console`)
    )
    expect(
      JSON.parse((await p.store.ROUTES.get(`host:${p.name}`)) ?? "{}")
    ).toMatchObject({ org_id: p.orgId, canonical_host: p.name })
    expect(
      JSON.parse((await p.store.ROUTES.get(`host:www.${p.name}`)) ?? "{}")
    ).toEqual({ redirect_to: p.name })

    expect(await remove(p.env, kit, p.orgId, p.name)).toBeNull()
    // A repeat finds the renewal cancelled and cancels nothing again.
    expect(await remove(p.env, kit, p.orgId, p.name)).toBeNull()
    const deleted = p.net.calls
      .filter((c) => c.method === "DELETE")
      .map((c) => c.url.split("/").at(-1))
    expect(deleted.filter((d) => d === "sub_123")).toHaveLength(1)
    expect(new Set(deleted)).toEqual(
      new Set([
        "sub_123",
        encodeURIComponent(`wd-${p.name}`),
        encodeURIComponent(`wd-www.${p.name}`),
      ])
    )
    const renewal = p.net.calls.filter(
      (c) => c.method === "PATCH" && c.url.endsWith(`/registrations/${p.name}`)
    )
    expect(renewal.map((c) => JSON.parse(c.body))).toContainEqual({
      auto_renew: false,
    })
  })

  it("live: a bought domain past its expiry is kept when the registrar renewed it, and taken down and told when it lapsed", async () => {
    const p = await paid(true)
    await startRegistration(p.env, kit, p.orgId, p.row.id)
    await captureRegistered(p.env, kit, p.orgId, p.row.id)
    await subscribeRenewal(p.env, kit, p.orgId, p.row.id)
    await serveBought(p.env, kit, p.orgId, p.row.id)
    p.net.site = p.orgId
    await activateDomain(p.env, kit, p.orgId, p.row.id)
    await openChat(kit, p.orgId)
    const day = 86_400_000
    const expire = async () => {
      const row = await rowOf(p.orgId, p.name)
      const registration = row.registration as DomainRegistration
      await kit.withOrg({ orgId: p.orgId }, (db) =>
        db
          .update(domains)
          .set({
            registration: {
              ...registration,
              expires_at: new Date(Date.now() - day).toISOString(),
            },
          })
          .where(eq(domains.id, row.id))
      )
    }
    const pointer = () => p.store.ROUTES.get(`host:${p.name}`)

    // Not yet past: no question asked of the registrar.
    const calls = p.net.calls.length
    expect(await sweepDomains(p.env, kit, p.orgId, "2026102706")).toEqual([])
    expect(p.net.calls).toHaveLength(calls)

    // Past, but renewed: the new date is kept and nothing is said.
    const renewed = new Date(Date.now() + 365 * day).toISOString()
    p.net.expires = renewed
    await expire()
    expect(await sweepDomains(p.env, kit, p.orgId, "2026102706")).toEqual([])
    expect((await rowOf(p.orgId, p.name)).state).toBe("active")
    expect((await rowOf(p.orgId, p.name)).registration).toMatchObject({
      expires_at: renewed,
    })
    expect(await pointer()).not.toBeNull()

    // Past and gone from the registrar: out of active, no longer served, told once.
    await expire()
    p.net.registered.delete(p.name)
    const says = await sweepDomains(p.env, kit, p.orgId, "2026102706")
    expect(says).toHaveLength(1)
    expect(says[0]?.text).toContain(`${p.name} wasn't renewed`)
    expect((await rowOf(p.orgId, p.name)).state).toBe("removed")
    expect(await pointer()).toBeNull()
    expect(await sweepDomains(p.env, kit, p.orgId, "2026102806")).toEqual([])
    await postStatus(kit, p.orgId, says[0] as Say)
    await postStatus(kit, p.orgId, says[0] as Say)
    expect(await chatTexts(kit, p.orgId)).toEqual([
      expect.stringContaining("wasn't renewed"),
    ])
  })

  it("renewals: keeps auto-renew on a paid invoice, says how to pay a failed one, turns it off when the subscription ends", async () => {
    const p = await paid(true)
    await startRegistration(p.env, kit, p.orgId, p.row.id)
    await captureRegistered(p.env, kit, p.orgId, p.row.id)
    await kit.withOrg({ orgId: p.orgId }, (db) =>
      db
        .update(domains)
        .set({ state: "active" })
        .where(eq(domains.id, p.row.id))
    )
    const event = (type: string, extra: Record<string, string>) =>
      paymentEvent(p.env, kit, p.orgId, p.row.id, {
        type,
        event_id: `evt_${crypto.randomUUID().slice(0, 8)}`,
        domain_id: p.row.id,
        subscription: "sub_123",
        ...extra,
      })
    const patches = () =>
      p.net.calls
        .filter((c) => c.method === "PATCH")
        .map((c) => JSON.parse(c.body))

    // Already renewing: nothing to switch.
    await event("renewal_paid", { invoice: "in_123" })
    expect(patches()).toEqual([])

    await event("renewal_failed", { invoice: "in_123" })
    expect(await typesOf(p.orgId, "domain.status")).toEqual(["domain.status"])

    await event("subscription_ended", {})
    expect(patches()).toEqual([{ auto_renew: false }])
    expect((await rowOf(p.orgId, p.name)).registration).toMatchObject({
      auto_renew: false,
    })
    await event("renewal_paid", { invoice: "in_124" })
    expect(patches()).toEqual([{ auto_renew: false }, { auto_renew: true }])
  })

  it("an account takedown leaves a paid purchase to finish and removes an unpaid one", async () => {
    const p = await paid()
    const name = unique()
    p.net.checks[name] = priced(name)
    await buy(p.env, kit, p.orgId, { name, ...details })
    await revokeDomains(p.env, kit, p.orgId)
    expect((await rowOf(p.orgId, p.name)).state).toBe("verifying")
    expect((await rowOf(p.orgId, name)).state).toBe("removed")
  })
})

describe.skipIf(!url)("buying a name elsewhere, against a database", () => {
  const stepOf = async (orgId: string, step: string) => {
    const tasks = await kit.withOrg({ orgId }, (db) => readTasks(db))
    const task = tasks.find((t) => t.kind === "address")
    return { task, step: task?.steps.find((s) => s.step === step) }
  }

  it("marks the purchase step the owner's and starts one hold per org and name", async () => {
    const site = await published()
    const setup = buyEnv(site.store)
    const name = unique()
    expect(await buyElsewhere(setup.env, kit, site.orgId, { name })).toBeNull()
    expect((await stepOf(site.orgId, "purchase")).step).toMatchObject({
      state: "blocked",
      blocked_on: "owner_action",
      note: `buying ${name}`,
    })
    expect((await stepOf(site.orgId, "purchase")).task?.detail).toMatchObject({
      name,
      origin: "buying_elsewhere",
    })
    // A second click finds the same hold.
    await buyElsewhere(setup.env, kit, site.orgId, { name })
    expect(setup.holds).toEqual([
      {
        id: await elsewhereId(site.orgId, name),
        params: { org_id: site.orgId, name },
      },
    ])
    expect(
      await buyElsewhere(setup.env, kit, site.orgId, { name: "not a name" })
    ).toMatchObject({ status: 400 })
  })

  it("on the owner's done, wakes the hold, and connects once the registry shows the name", async () => {
    const site = await published()
    const setup = buyEnv(site.store)
    const name = unique()
    await buyElsewhere(setup.env, kit, site.orgId, { name })
    const id = await elsewhereId(site.orgId, name)
    expect(await boughtElsewhere(setup.env, kit, site.orgId, { name })).toEqual(
      {
        status: 200,
        output: { outcome: "not_registered_yet", name },
      }
    )
    expect((await stepOf(site.orgId, "purchase")).step?.state).toBe("blocked")
    rdap.registered.add(name)
    const done = await boughtElsewhere(setup.env, kit, site.orgId, { name })
    expect(done).toMatchObject({
      status: 201,
      output: { outcome: "connecting" },
      body: { name, approval_id: `owner_done:${name}` },
    })
    expect((await stepOf(site.orgId, "purchase")).step?.state).toBe("done")
    expect(setup.woken).toEqual([`${id} owner_done`, `${id} owner_done`])
  })

  it("offers the connect once the daily look sees the name, and says nothing once a claim is open", async () => {
    const site = await published()
    const setup = buyEnv(site.store)
    const name = unique()
    await buyElsewhere(setup.env, kit, site.orgId, { name })
    const quiet = await lookElsewhere(kit, site.orgId, name)
    expect(quiet.result).toMatchObject({ registered: false, claimed: false })
    rdap.registered.add(name)
    const seen = await lookElsewhere(kit, site.orgId, name)
    expect(seen.result).toMatchObject({ registered: true, claimed: false })
    expect(seen.reading?.write).toEqual({ state: "done" })
    expect(await seen.reading?.tell?.()).toEqual({
      text: `${name} is registered now. Shall I put your website on it?`,
      button: {
        label: "Put my site on it",
        action: { kind: "ask", text: `Put my site on ${name}.` },
      },
    })
    await kit.withOrg({ orgId: site.orgId }, (db) =>
      db.insert(domains).values({
        orgId: site.orgId,
        siteId: site.orgId,
        name,
        primaryHost: name,
        origin: "connected",
        method: "records",
        state: "awaiting_dns",
      })
    )
    expect(await seen.reading?.tell?.()).toBeNull()
    expect((await lookElsewhere(kit, site.orgId, name)).result).toMatchObject({
      claimed: true,
    })
  })

  it("reads an ending with no RDAP server from DNS, never as not bought", async () => {
    rdap.unlisted.add("io")
    const name = `bright${crypto.randomUUID().slice(0, 8)}.io`
    expect(await isRegistered(name)).toBe(false)
    rdap.zones.add(name)
    expect(await isRegistered(name)).toBe(true)
    rdap.registered.add("rdap-says.com")
    expect(await isRegistered("rdap-says.com")).toBe(true)
  })

  it("follows up once and puts the address task off for a week", async () => {
    const site = await published()
    const setup = buyEnv(site.store)
    const name = unique()
    await buyElsewhere(setup.env, kit, site.orgId, { name })
    const say = await followUpElsewhere(kit, site.orgId, name)
    expect(say.text).toBe(
      `Did you get ${name}? Once it's yours, tell me and I'll put your website on it.`
    )
    const { task } = await stepOf(site.orgId, "purchase")
    expect(task?.state).toBe("later")
    expect(Date.parse(task?.later_until ?? "")).toBeGreaterThan(
      Date.now() + 6 * 24 * 60 * 60 * 1000
    )
  })
})

describe("the details a purchase keeps", () => {
  it("keeps who the registrant is in law only for .co.uk and .uk", () => {
    const legal = {
      registrant_type: "IND" as const,
      company_number: "00000000",
    }
    expect(heldDetails("bright.com", { ...details, ...legal })).toEqual({
      registrant: details.registrant,
    })
    expect(heldDetails("bright.co.uk", { ...details, ...legal })).toEqual({
      registrant: details.registrant,
      ...legal,
    })
  })
})
