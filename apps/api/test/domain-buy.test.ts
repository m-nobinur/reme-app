import { DomainCheckout, ErrorEnvelope } from "@workspace/contracts"
import {
  domains,
  eq,
  memberships,
  orgs,
  sql,
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
    organization: "Sparkle Clean",
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

    const [customer, session] = stripe
    expect(customer?.path).toBe("customers")
    expect(customer?.key).toBe(`customer:${me.orgId}`)
    expect(session?.path).toBe("checkout/sessions")
    const form = Object.fromEntries(session?.body ?? [])
    expect(form).toMatchObject({
      mode: "payment",
      ui_mode: "embedded_page",
      customer: CUSTOMER,
      redirect_on_completion: "if_required",
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

    const [call] = stub.calls
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
    expect(again.map((a) => a.path)).toEqual(["checkout/sessions"])
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
      })
    )
    const stub = told()
    const response = await checkout(me, stub, name)
    expect(response.status).toBe(200)
    expect((await response.json()).client_secret).toBe("cs_secret2")
    expect(stripe.map((a) => [a.method, a.path])).toEqual([
      ["GET", "checkout/sessions/cs_test_open"],
    ])
    // The owner's latest details still reach the orchestrator.
    expect(stub.calls[0]?.body).toMatchObject({
      session_id: "cs_test_open",
      customer: "cus_kept",
    })
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
    expect(stub.calls).toEqual([])
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
})
