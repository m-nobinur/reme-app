import {
  DomainCheckout,
  DomainRegistrantPrefill,
  ErrorEnvelope,
} from "@workspace/contracts"
import {
  domains,
  eq,
  memberships,
  orgs,
  sql,
  supersedeFact,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  type Owner,
  owner,
  type Stub,
  stubOrchestrator,
} from "./owner-fixture.ts"
import { stubJwksFetch } from "./sealed-session.ts"

/**
 * The buy path's owner routes and CoS tools on a live connection, Stripe
 * and the orchestrator stood in for: the amount comes from the row, never
 * the request; one Customer per org; an open session is handed back; and
 * only the org's owner, with the keys set, gets anywhere.
 */

const url = process.env.DATABASE_URL
// Unique per run: `orgs.stripe_customer_id` is unique across orgs.
const CUSTOMER = `cus_fixture${crypto.randomUUID().slice(0, 8)}`
const STRIPE = {
  STRIPE_SECRET_KEY: "sk_fixture",
  STRIPE_WEBHOOK_SECRET: "whsec_fix",
}

const details = {
  registrant: {
    name: "Jane Smith",
    business_name: "Sparkle Clean",
    email: "jane@sparkle.invalid",
    phone: "+447700900123",
    address: {
      street: "12 Mill Lane",
      city: "Bristol",
      postal_code: "BS1 4AB",
      country_code: "GB",
    },
  },
  registrant_type: "STRA",
} as const

/** Stripe's API as the tests see it, every call recorded. */
type Asked = {
  method: string
  path: string
  body: URLSearchParams
  key: string | null
}

function stubStripe(
  answer: (asked: Asked) => Response = (asked) =>
    asked.path === "customers"
      ? Response.json({ id: CUSTOMER })
      : Response.json({
          id: "cs_test_fixture1",
          status: "open",
          client_secret: "cs_secret1",
          expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
          ui_mode: "elements",
        })
) {
  const jwks = stubJwksFetch()
  const calls: Asked[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const at = String(input)
    if (!at.startsWith("https://api.stripe.com/v1/")) return jwks(input, init)
    const asked = {
      method: init?.method ?? "GET",
      path: at.slice("https://api.stripe.com/v1/".length),
      body: new URLSearchParams(String(init?.body ?? "")),
      key: new Headers(init?.headers).get("idempotency-key"),
    }
    calls.push(asked)
    return answer(asked)
  }) as typeof fetch
  return calls
}

const told = () => stubOrchestrator(() => new Response(null, { status: 204 }))

describe.skipIf(!url)("buying a domain, on a live connection", () => {
  const kit: Tenancy = tenancy(url as string, { max: 3 })
  let realFetch: typeof fetch
  let me: Owner
  let other: Owner

  beforeAll(async () => {
    realFetch = globalThis.fetch
    globalThis.fetch = stubJwksFetch()
    me = await owner(kit, url as string, "buy")
    other = await owner(kit, url as string, "buy-other")
  }, 60_000)

  afterAll(async () => {
    globalThis.fetch = realFetch
    await kit.close()
  })

  /** A purchase the orchestrator would have made, waiting on payment. */
  async function purchase(
    who: Owner,
    name: string,
    extra: Partial<typeof domains.$inferInsert> = {}
  ) {
    const [row] = await kit.withOrg({ orgId: who.orgId }, (db) =>
      db
        .insert(domains)
        .values({
          orgId: who.orgId,
          siteId: crypto.randomUUID(),
          name,
          primaryHost: name,
          origin: "purchased",
          method: "purchased",
          state: "awaiting_payment",
          price: { tld: "co.uk", retail_gbp: 8, cost_usd: 5.3 },
          ...extra,
        })
        .returning({ id: domains.id })
    )
    return row?.id as string
  }

  const unique = (tag: string) =>
    `${tag}-${crypto.randomUUID().slice(0, 8)}.co.uk`

  const checkout = (
    who: Owner,
    stub: Stub,
    name: string,
    {
      key = crypto.randomUUID(),
      body = details as unknown,
      bindings = STRIPE as Record<string, unknown>,
    } = {}
  ) =>
    who.call(stub, `/domains/${name}/checkout`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
      },
      body: JSON.stringify(body),
      bindings: { ...bindings, WEB_ORIGIN: "https://staging.remeai.co.uk" },
    })

  it("opens a manual-capture Checkout priced from the row, makes the Customer once and tells the orchestrator", async () => {
    const name = unique("sparkle")
    const id = await purchase(me, name)
    const stripe = stubStripe()
    const stub = told()
    const response = await checkout(me, stub, name)
    expect(response.status).toBe(200)
    expect(DomainCheckout.parse(await response.json())).toMatchObject({
      name,
      price_gbp: 8,
      client_secret: "cs_secret1",
    })

    const [customer, email, session] = stripe
    expect(customer?.path).toBe("customers")
    expect(customer?.key).toBe(`customer:${me.orgId}`)
    // Checkout reads the email from the Customer, so the page sends none.
    expect(email?.path).toBe(`customers/${CUSTOMER}`)
    expect(email?.body.get("email")).toBe(details.registrant.email)
    expect(session?.path).toBe("checkout/sessions")
    expect(session?.body.has("customer_email")).toBe(false)
    const form = Object.fromEntries(session?.body ?? [])
    expect(form).toMatchObject({
      mode: "payment",
      ui_mode: "elements",
      customer: CUSTOMER,
      return_url: `https://staging.remeai.co.uk/app/domains/return?name=${name}&session_id={CHECKOUT_SESSION_ID}`,
      "line_items[0][price_data][currency]": "gbp",
      "line_items[0][price_data][unit_amount]": "800",
      "line_items[0][price_data][product_data][name]": `${name}, 1 year`,
      "payment_intent_data[capture_method]": "manual",
      "payment_intent_data[setup_future_usage]": "off_session",
      "payment_intent_data[metadata][org_id]": me.orgId,
      "payment_intent_data[metadata][domain_id]": id,
      "metadata[org_id]": me.orgId,
      "metadata[domain_id]": id,
    })
    expect(
      Object.keys(form).some((k) => k.startsWith("payment_method_types"))
    ).toBe(false)
    const ttl = Number(form.expires_at) - Date.now() / 1000
    expect(ttl).toBeGreaterThan(30 * 60)
    expect(ttl).toBeLessThanOrEqual(31 * 60)

    // The purchase is opened or refreshed first, then told its session.
    const [opened, call] = stub.calls
    expect(new URL(opened?.request.url ?? "").pathname).toBe(
      "/assignments/domains/buy"
    )
    expect(opened?.body).toEqual({ name, ...details })
    expect(new URL(call?.request.url ?? "").pathname).toBe(
      `/assignments/domains/${id}/checkout-session`
    )
    expect(call?.body).toEqual({
      session_id: "cs_test_fixture1",
      customer: CUSTOMER,
      ...details,
    })

    const [org] = await kit.withOrg({ orgId: me.orgId }, (db) =>
      db
        .select({ customer: orgs.stripeCustomerId })
        .from(orgs)
        .where(eq(orgs.id, me.orgId))
    )
    expect(org?.customer).toBe(CUSTOMER)
    // A second purchase reuses the stored Customer.
    const second = unique("sparkle-two")
    await purchase(me, second)
    const again = stubStripe()
    expect((await checkout(me, told(), second)).status).toBe(200)
    expect(again.map((a) => a.path)).toEqual([
      `customers/${CUSTOMER}`,
      "checkout/sessions",
    ])
  })

  it("hands back a session Stripe still holds open instead of making a second", async () => {
    const name = unique("reopen")
    await purchase(me, name, {
      stripe: { customer: "cus_kept", checkout_session: "cs_test_open" },
    })
    const stripe = stubStripe(() =>
      Response.json({
        id: "cs_test_open",
        status: "open",
        client_secret: "cs_secret2",
        expires_at: Math.floor(Date.now() / 1000) + 600,
        ui_mode: "elements",
      })
    )
    const stub = told()
    const response = await checkout(me, stub, name)
    expect(response.status).toBe(200)
    expect(DomainCheckout.parse(await response.json()).client_secret).toBe(
      "cs_secret2"
    )
    expect(stripe.map((a) => [a.method, a.path])).toEqual([
      ["GET", "checkout/sessions/cs_test_open"],
    ])
    // The owner's latest details still reach the orchestrator.
    expect(stub.calls[1]?.body).toMatchObject({
      session_id: "cs_test_open",
      customer: "cus_kept",
    })
  })

  it("replaces an open embedded_page session, expiring it only once the orchestrator holds the new one", async () => {
    const name = unique("embedded")
    await purchase(me, name, {
      stripe: { customer: "cus_kept", checkout_session: "cs_test_old" },
    })
    const stub = told()
    let toldBeforeExpire = -1
    const later = Math.floor(Date.now() / 1000) + 600
    const stripe = stubStripe(({ method, path }) => {
      if (path.endsWith("/expire")) {
        toldBeforeExpire = stub.calls.length
        return Response.json({ id: "cs_test_old", status: "expired" })
      }
      return method === "GET"
        ? Response.json({
            id: "cs_test_old",
            status: "open",
            client_secret: "cs_old",
            expires_at: later,
            ui_mode: "embedded_page",
          })
        : Response.json({
            id: "cs_test_new",
            status: "open",
            client_secret: "cs_new",
            expires_at: later,
            ui_mode: "elements",
          })
    })
    const response = await checkout(me, stub, name)
    expect(response.status).toBe(200)
    expect(DomainCheckout.parse(await response.json()).client_secret).toBe(
      "cs_new"
    )
    expect(stripe.map((a) => [a.method, a.path])).toEqual([
      ["GET", "checkout/sessions/cs_test_old"],
      ["POST", "customers/cus_kept"],
      ["POST", "checkout/sessions"],
      ["POST", "checkout/sessions/cs_test_old/expire"],
    ])
    expect(stub.calls[1]?.body).toMatchObject({ session_id: "cs_test_new" })
    // The old session's expiry webhook then names a session not held.
    expect(toldBeforeExpire).toBe(2)
  })

  it("refuses without the Stripe keys, for a member who is not the owner, and for another org's purchase", async () => {
    const name = unique("refused")
    await purchase(other, name)
    const stripe = stubStripe()
    const stub = told()
    const off = await checkout(me, stub, name, { bindings: {} })
    expect(off.status).toBe(409)
    expect(ErrorEnvelope.parse(await off.json()).code).toBe(
      "domain.buy_unavailable"
    )
    const elsewhere = await checkout(me, stub, name)
    expect(elsewhere.status).toBe(404)
    const member = await owner(kit, url as string, "buy-member")
    await kit.withOrg({ orgId: member.orgId }, (db) =>
      db
        .update(memberships)
        .set({ role: "member" })
        .where(sql`${memberships.orgId} = ${member.orgId}`)
    )
    await purchase(member, unique("member"))
    const notOwner = await checkout(member, stub, name)
    expect(notOwner.status).toBe(403)
    expect(ErrorEnvelope.parse(await notOwner.json()).code).toBe(
      "domain.not_owner"
    )
    expect(stripe).toEqual([])
    // Only the owner's own Pay reached the orchestrator, which opens nothing
    // for a name another org holds.
    expect(stub.calls.map((c) => new URL(c.request.url).pathname)).toEqual([
      "/assignments/domains/buy",
    ])
  })

  it("relays the orchestrator's refusal to open the purchase and asks Stripe nothing", async () => {
    const stripe = stubStripe()
    const taken = stubOrchestrator(() =>
      Response.json(
        {
          class: "resource",
          code: "domain.unavailable",
          message: "That name isn't free to register.",
          detail: {},
          occurred_at: new Date().toISOString(),
        },
        { status: 409 }
      )
    )
    const refused = await checkout(me, taken, unique("taken"))
    expect(refused.status).toBe(409)
    expect(ErrorEnvelope.parse(await refused.json()).code).toBe(
      "domain.unavailable"
    )
    expect(stripe).toEqual([])
  })

  it("prefills the details page from the facts and the owner, and lists only the gaps", async () => {
    const prefill = async (who: Owner, name: string) => {
      const response = await who.call(told(), `/domains/${name}/registrant`)
      return { status: response.status, body: await response.json() }
    }
    const fresh = await owner(kit, url as string, "buy-prefill")
    await kit.withOrg({ orgId: fresh.orgId }, async (db) => {
      for (const [key, value] of [
        ["business.name", { name: "Sparkle Clean" }],
        ["business.phone", { e164: "+447700900123" }],
        ["business.email", { address: "hello@sparkle.invalid" }],
      ] as const)
        await supersedeFact(db, {
          orgId: fresh.orgId,
          key,
          factType: "business",
          value,
          provenance: { source: "owner_stated", confidence: 1 },
        })
    })
    const com = await prefill(
      fresh,
      `fresh-${crypto.randomUUID().slice(0, 8)}.com`
    )
    expect(com.status).toBe(200)
    const body = DomainRegistrantPrefill.parse(com.body)
    expect(body).toMatchObject({
      price_gbp_year: 12,
      registrant: { business_name: "Sparkle Clean", phone: "+447700900123" },
    })
    expect(body.registrant.email).toBeTruthy()
    // The address is the only gap; a .com never asks who registers it.
    expect(body.missing).toEqual(
      expect.arrayContaining(["street", "city", "postal_code", "country_code"])
    )
    expect(body.missing).not.toContain("phone")
    expect(body.missing).not.toContain("email")
    expect(body.missing).not.toContain("registrant_type")
    // An open purchase's details win, and a .co.uk asks the registrant type.
    await purchase(fresh, unique("held"), { registrant: details })
    const uk = DomainRegistrantPrefill.parse(
      (await prefill(fresh, unique("next"))).body
    )
    expect(uk.registrant).toEqual(details.registrant)
    expect(uk.missing).toEqual(["registrant_type"])
    expect((await prefill(fresh, "nope.example")).status).toBe(409)
  })

  it("refuses a purchase past payment, a body off the contract and a missing key", async () => {
    const name = unique("paid")
    await purchase(me, name, { state: "verifying" })
    const stripe = stubStripe()
    const stub = told()
    const paid = await checkout(me, stub, name)
    expect(paid.status).toBe(409)
    expect(ErrorEnvelope.parse(await paid.json()).code).toBe(
      "domain.not_awaiting_payment"
    )
    const bad = await checkout(me, stub, name, {
      body: { registrant: { name: "x" } },
    })
    expect(bad.status).toBe(400)
    const keyless = await checkout(me, stub, name, { key: "" })
    expect(keyless.status).toBe(400)
    expect(stripe).toEqual([])
  })

  it("answers 503 when Stripe fails, and relays the orchestrator's refusal of the details", async () => {
    const name = unique("fails")
    await purchase(me, name)
    stubStripe(() =>
      Response.json({ error: { type: "api_error" } }, { status: 500 })
    )
    const down = await checkout(me, told(), name)
    expect(down.status).toBe(503)
    expect(ErrorEnvelope.parse(await down.json()).code).toBe(
      "stripe.unavailable"
    )
    stubStripe()
    const invalid = stubOrchestrator(() =>
      Response.json(
        {
          class: "validation",
          code: "domain.registrant_invalid",
          message: "The registration details aren't complete for that domain.",
          detail: {},
          occurred_at: new Date().toISOString(),
        },
        { status: 400 }
      )
    )
    const refused = await checkout(me, invalid, name)
    expect(refused.status).toBe(400)
    expect(ErrorEnvelope.parse(await refused.json()).code).toBe(
      "domain.registrant_invalid"
    )
  })

  it("bridges buying elsewhere and the owner's done, owner only and with no Stripe keys", async () => {
    const name = `away-${crypto.randomUUID().slice(0, 8)}.com`
    const stub = stubOrchestrator((request) =>
      request.url.endsWith("/bought")
        ? Response.json({ outcome: "not_registered_yet", name })
        : new Response(null, { status: 204 })
    )
    const post = (who: Owner, action: string) =>
      who.call(stub, `/domains/${name}/${action}`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
      })
    expect((await post(me, "elsewhere")).status).toBe(204)
    const done = await post(me, "bought")
    expect(await done.json()).toEqual({ outcome: "not_registered_yet", name })
    expect(
      stub.calls.map((c) => [new URL(c.request.url).pathname, c.body])
    ).toEqual([
      ["/assignments/domains/elsewhere", { name }],
      ["/assignments/domains/bought", { name }],
    ])
    const member = await owner(kit, url as string, "away-member")
    await kit.withOrg({ orgId: member.orgId }, (db) =>
      db
        .update(memberships)
        .set({ role: "member" })
        .where(sql`${memberships.orgId} = ${member.orgId}`)
    )
    expect((await post(member, "bought")).status).toBe(403)
  })

  it("bridges the check the owner's tab asks for back from Domain Connect", async () => {
    const name = `back-${crypto.randomUUID().slice(0, 8)}.com`
    const checked = {
      outcome: "checked",
      state: "awaiting_dns",
      status: { status: "pending_verification" },
      next_step: "Records seen, certificate next.",
    }
    const stub = stubOrchestrator(() => Response.json(checked))
    const response = await me.call(stub, `/domains/${name}/check`, {
      method: "POST",
    })
    expect(await response.json()).toEqual(checked)
    expect(stub.calls.map((c) => new URL(c.request.url).pathname)).toEqual([
      `/assignments/domains/${name}/check`,
    ])
  })

  it("reads the newest purchase of a name, its sandbox flag and how it closed", async () => {
    const name = unique("status")
    const status = async (who: Owner) => {
      const response = await who.call(told(), `/domains/${name}`)
      return { status: response.status, body: await response.json() }
    }
    await purchase(me, name, {
      state: "abandoned",
      registration: { sandbox: true, outcome: "expired" },
    })
    expect(await status(me)).toEqual({
      status: 200,
      body: { name, state: "abandoned", test: true, outcome: "expired" },
    })
    await purchase(me, name, { registration: { sandbox: false } })
    expect(await status(me)).toEqual({
      status: 200,
      body: { name, state: "awaiting_payment", test: false },
    })
    // Another org's purchase of the same name is not there for it.
    expect((await status(other)).status).toBe(404)
  })
})
