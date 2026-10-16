import { createHmac } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  form,
  STRIPE_VERSION,
  StripeFailed,
  stripePost,
  verifyStripeSignature,
} from "../src/stripe.ts"

const SIGNING = "whsec_test_0123456789abcdef"
const NOW = 1_792_000_000

/** A header signed the way Stripe signs it, by node's HMAC rather than ours. */
const signed = (body: string, t = NOW, secret = SIGNING) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")},v0=ignored`

const raw = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" })

describe("verifyStripeSignature", () => {
  it("accepts a body Stripe signed", async () => {
    expect(await verifyStripeSignature(raw, signed(raw), SIGNING, NOW)).toBe(
      true
    )
  })

  it("accepts a rolled secret's second v1", async () => {
    const header = `${signed(raw, NOW, "whsec_old")},${signed(raw).split(",")[1]}`
    expect(await verifyStripeSignature(raw, header, SIGNING, NOW)).toBe(true)
  })

  it("refuses a forged signature, a changed body and another secret", async () => {
    const forged = `t=${NOW},v1=${"0".repeat(64)}`
    expect(await verifyStripeSignature(raw, forged, SIGNING, NOW)).toBe(false)
    expect(
      await verifyStripeSignature(`${raw} `, signed(raw), SIGNING, NOW)
    ).toBe(false)
    expect(
      await verifyStripeSignature(
        raw,
        signed(raw, NOW, "whsec_x"),
        SIGNING,
        NOW
      )
    ).toBe(false)
  })

  it("refuses a signature outside five minutes, either way", async () => {
    expect(
      await verifyStripeSignature(raw, signed(raw, NOW - 301), SIGNING, NOW)
    ).toBe(false)
    expect(
      await verifyStripeSignature(raw, signed(raw, NOW + 301), SIGNING, NOW)
    ).toBe(false)
    expect(
      await verifyStripeSignature(raw, signed(raw, NOW - 300), SIGNING, NOW)
    ).toBe(true)
  })

  it("refuses no header, no t and no v1", async () => {
    expect(await verifyStripeSignature(raw, null, SIGNING, NOW)).toBe(false)
    expect(await verifyStripeSignature(raw, "v1=abc", SIGNING, NOW)).toBe(false)
    expect(await verifyStripeSignature(raw, `t=${NOW}`, SIGNING, NOW)).toBe(
      false
    )
  })
})

describe("form", () => {
  it("encodes nested objects and arrays the way Stripe reads them", () => {
    expect(
      form({
        mode: "payment",
        skip: undefined,
        line_items: [{ quantity: 1, price_data: { unit_amount: 800 } }],
        payment_intent_data: { metadata: { domain_id: "d1" } },
      }).toString()
    ).toBe(
      "mode=payment&line_items%5B0%5D%5Bquantity%5D=1&line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=800&payment_intent_data%5Bmetadata%5D%5Bdomain_id%5D=d1"
    )
  })
})

describe("stripePost", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("sends the key, the pinned version and the idempotency key", async () => {
    const fetch = vi.fn(async () => Response.json({ id: "cus_1" }))
    vi.stubGlobal("fetch", fetch)
    expect(
      await stripePost("sk_test_1", "customers", { name: "A" }, "k1")
    ).toEqual({ id: "cus_1" })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    const headers = new Headers(init.headers)
    expect(url).toBe("https://api.stripe.com/v1/customers")
    expect(headers.get("authorization")).toBe("Bearer sk_test_1")
    expect(headers.get("stripe-version")).toBe(STRIPE_VERSION)
    expect(headers.get("idempotency-key")).toBe("k1")
    expect(String(init.body)).toBe("name=A")
  })

  it("throws Stripe's status and error code", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json(
        { error: { type: "invalid_request_error", code: "resource_missing" } },
        { status: 400 }
      )
    )
    const failed = await stripePost("sk", "customers", {}).catch((e) => e)
    expect(failed).toBeInstanceOf(StripeFailed)
    expect(failed).toMatchObject({ status: 400, code: "resource_missing" })
  })
})
