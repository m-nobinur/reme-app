import { afterEach, describe, expect, it, vi } from "vitest"
import {
  capturePayment,
  createRenewal,
  form,
  getInvoice,
  releasePayment,
  STRIPE_VERSION,
} from "../src/stripe.ts"
import {
  INVOICE,
  PI,
  STRIPE_MISSING,
  SUBSCRIPTION,
} from "./fixtures/registrar.ts"

const env = { STRIPE_SECRET_KEY: "sk_test_x" }
const API = "https://api.stripe.com/v1"

type Call = { url: string; method: string; body: string; headers: Headers }

function stub(routes: Record<string, () => Response>) {
  const calls: Call[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? "GET"
      calls.push({
        url,
        method,
        body: String(init?.body ?? ""),
        headers: new Headers(init?.headers),
      })
      const route = routes[`${method} ${url}`]
      if (!route) throw new Error(`unexpected ${method} ${url}`)
      return route()
    })
  )
  return calls
}
const json =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status })

afterEach(() => vi.unstubAllGlobals())

describe("Stripe form encoding", () => {
  it("nests objects and arrays the way Stripe reads them", () => {
    expect(
      form({
        a: 1,
        items: [{ price_data: { currency: "gbp" } }],
        m: { k: "v w" },
        n: undefined,
      })
    ).toEqual([
      "a=1",
      "items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=gbp",
      "m%5Bk%5D=v%20w",
    ])
  })
})

describe("the hold", () => {
  it("captures with the domain's idempotency key and a pinned version", async () => {
    const calls = stub({
      [`GET ${API}/payment_intents/pi_123`]: json(PI("requires_capture")),
      [`POST ${API}/payment_intents/pi_123/capture`]: json(PI("succeeded")),
    })
    expect((await capturePayment(env, "pi_123", "dom")).status).toBe(
      "succeeded"
    )
    const post = calls[1]
    expect(post?.headers.get("idempotency-key")).toBe("domain-capture-dom")
    expect(post?.headers.get("stripe-version")).toBe(STRIPE_VERSION)
    expect(post?.headers.get("authorization")).toBe("Bearer sk_test_x")
  })

  it("does not capture twice", async () => {
    const calls = stub({
      [`GET ${API}/payment_intents/pi_123`]: json(PI("succeeded")),
    })
    await capturePayment(env, "pi_123", "dom")
    expect(calls).toHaveLength(1)
  })

  it("releases a hold, is done with one released, and never touches a captured one", async () => {
    let calls = stub({
      [`GET ${API}/payment_intents/pi_123`]: json(PI("requires_capture")),
      [`POST ${API}/payment_intents/pi_123/cancel`]: json(PI("canceled")),
    })
    expect(await releasePayment(env, "pi_123", "dom")).toBe("released")
    expect(calls[1]?.headers.get("idempotency-key")).toBe("domain-cancel-dom")

    vi.unstubAllGlobals()
    calls = stub({
      [`GET ${API}/payment_intents/pi_123`]: json(PI("canceled")),
    })
    expect(await releasePayment(env, "pi_123", "dom")).toBe("released")
    expect(calls).toHaveLength(1)

    vi.unstubAllGlobals()
    calls = stub({
      [`GET ${API}/payment_intents/pi_123`]: json(PI("succeeded")),
    })
    expect(await releasePayment(env, "pi_123", "dom")).toBe("captured")
    expect(calls).toHaveLength(1)
  })

  it("refuses a PaymentIntent another purchase made", async () => {
    const calls = stub({
      [`GET ${API}/payment_intents/pi_123`]: json(
        PI("requires_capture", { metadata: { domain_id: "other" } })
      ),
    })
    await expect(capturePayment(env, "pi_123", "dom")).rejects.toThrow(
      "stripe.payment_mismatch"
    )
    await expect(releasePayment(env, "pi_123", "dom")).rejects.toThrow(
      "stripe.payment_mismatch"
    )
    expect(calls.every((c) => c.method === "GET")).toBe(true)
  })

  it("calls a Stripe outage retryable", async () => {
    stub({
      [`GET ${API}/payment_intents/pi_123`]: json(
        { error: { type: "api_error" } },
        500
      ),
    })
    await expect(capturePayment(env, "pi_123", "dom")).rejects.toThrow(
      "stripe.unavailable"
    )
  })

  it("fails by Stripe's code, and as not configured without a key", async () => {
    stub({
      [`GET ${API}/payment_intents/pi_123`]: json(
        { error: { code: "resource_missing", type: "invalid_request_error" } },
        404
      ),
    })
    await expect(capturePayment(env, "pi_123", "dom")).rejects.toThrow(
      "stripe.resource_missing"
    )
    await expect(capturePayment({}, "pi_123", "dom")).rejects.toThrow(
      "stripe.not_configured"
    )
  })
})

describe("the renewal", () => {
  it("makes the TLD's product once, then subscribes anchored 50 days before expiry with no proration", async () => {
    const calls = stub({
      [`GET ${API}/products/reme_domain_co_uk`]: json(STRIPE_MISSING, 404),
      [`POST ${API}/products`]: json({ id: "reme_domain_co_uk" }),
      [`POST ${API}/subscriptions`]: json(SUBSCRIPTION),
    })
    const sub = await createRenewal(env, {
      orgId: "org",
      domainId: "dom",
      customer: "cus_123",
      paymentMethod: "pm_123",
      tld: "co.uk",
      pence: 800,
      expiresAt: "2027-10-16T12:00:05Z",
    })
    expect(sub.id).toBe("sub_123")
    expect(new URLSearchParams(calls[1]?.body).get("id")).toBe(
      "reme_domain_co_uk"
    )
    const body = new URLSearchParams(calls[2]?.body)
    const anchor = Date.parse("2027-08-27T12:00:05Z") / 1000
    expect(Object.fromEntries(body)).toEqual({
      customer: "cus_123",
      default_payment_method: "pm_123",
      "items[0][price_data][currency]": "gbp",
      "items[0][price_data][product]": "reme_domain_co_uk",
      "items[0][price_data][unit_amount]": "800",
      "items[0][price_data][recurring][interval]": "year",
      billing_cycle_anchor: String(anchor),
      proration_behavior: "none",
      "metadata[org_id]": "org",
      "metadata[domain_id]": "dom",
    })
    expect(calls[2]?.headers.get("idempotency-key")).toBe("domain-renewal-dom")
  })

  it("reuses the product that exists", async () => {
    const calls = stub({
      [`GET ${API}/products/reme_domain_com`]: json({ id: "reme_domain_com" }),
      [`POST ${API}/subscriptions`]: json(SUBSCRIPTION),
    })
    await createRenewal(env, {
      orgId: "org",
      domainId: "dom",
      customer: "cus_123",
      paymentMethod: "pm_123",
      tld: "com",
      pence: 1200,
      expiresAt: "2027-10-16T12:00:05Z",
    })
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"])
  })

  it("reads an invoice's pay link", async () => {
    stub({ [`GET ${API}/invoices/in_123`]: json(INVOICE) })
    expect((await getInvoice(env, "in_123")).hosted_invoice_url).toMatch(
      /^https:\/\/invoice\.stripe\.com\//
    )
  })
})
