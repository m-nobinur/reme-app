import { createHmac } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import worker from "../src/index.ts"
import { type Stub, stubOrchestrator } from "./owner-fixture.ts"
import { env } from "./sealed-session.ts"

/**
 * `POST /webhooks/stripe` end to end through the worker, Stripe and the
 * orchestrator stood in for: only a body Stripe signed gets through, the
 * org and domain come from the signed metadata, and each event is handed on
 * once per delivery under its own id as the key.
 */

const SIGNING = "whsec_fixture_for_webhook_tests"
const ORG = "0b5c5e8e-2a64-4b1e-9d36-0d3f0d0c0a11"
const DOMAIN = "7d1f4a52-8b0c-4c55-a3a2-55e0e4e1f0b2"
const ours = { org_id: ORG, domain_id: DOMAIN }

const ctx = { waitUntil: () => undefined } as unknown as ExecutionContext

const signed = (body: string, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac("sha256", SIGNING).update(`${t}.${body}`).digest("hex")}`

function deliver(
  stub: Stub,
  event: object,
  {
    header,
    configured = true,
  }: { header?: (raw: string) => string; configured?: boolean } = {}
) {
  const raw = JSON.stringify(event)
  return worker.fetch(
    new Request("http://api.invalid/webhooks/stripe", {
      method: "POST",
      headers: { "stripe-signature": (header ?? signed)(raw) },
      body: raw,
    }),
    {
      ...env("postgres://unused@127.0.0.1:1/unused"),
      ORCHESTRATOR: stub,
      ...(configured
        ? { STRIPE_SECRET_KEY: "sk_fixture", STRIPE_WEBHOOK_SECRET: SIGNING }
        : {}),
    } as unknown as Env,
    ctx
  )
}

/** Stripe's API, answering a PaymentIntent in `status`. */
function stripeAnswers(status: string) {
  const asked: string[] = []
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input)
    asked.push(url)
    if (url.startsWith("https://api.stripe.com/v1/payment_intents/")) {
      return Response.json({ id: "pi_1", status })
    }
    throw new Error(`the tests do not reach the network: ${url}`)
  })
  return asked
}

const completed = (id = "evt_completed_1") => ({
  id,
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_test_1",
      payment_intent: "pi_1",
      payment_status: "unpaid",
      metadata: ours,
    },
  },
})

const ok = () => new Response(null, { status: 204 })

describe("POST /webhooks/stripe", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("is not a route until the Stripe keys are set", async () => {
    const stub = stubOrchestrator(ok)
    const response = await deliver(stub, completed(), { configured: false })
    expect(response.status).toBe(404)
    expect(stub.calls).toHaveLength(0)
  })

  it("refuses a forged signature, a stale one and none, and tells nobody", async () => {
    const stub = stubOrchestrator(ok)
    const asked = stripeAnswers("requires_capture")
    for (const header of [
      () => `t=${Math.floor(Date.now() / 1000)},v1=${"a".repeat(64)}`,
      (raw: string) => signed(raw, Math.floor(Date.now() / 1000) - 301),
      () => "",
    ]) {
      const response = await deliver(stub, completed(), { header })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        code: "stripe.signature_invalid",
      })
    }
    expect(stub.calls).toHaveLength(0)
    expect(asked).toHaveLength(0)
  })

  it("hands a held payment to the orchestrator under the signed org, keyed by the event", async () => {
    const stub = stubOrchestrator(ok)
    stripeAnswers("requires_capture")
    const response = await deliver(stub, completed())
    expect(response.status).toBe(200)
    const [call] = stub.calls
    expect(new URL(call?.request.url ?? "").pathname).toBe(
      `/assignments/domains/${DOMAIN}/stripe`
    )
    expect(call?.request.headers.get("x-reme-org-id")).toBe(ORG)
    expect(call?.request.headers.get("idempotency-key")).toBe("evt_completed_1")
    expect(call?.body).toEqual({
      type: "paid",
      event_id: "evt_completed_1",
      domain_id: DOMAIN,
      checkout_session: "cs_test_1",
      payment_intent: "pi_1",
    })
  })

  it("hands on a replayed event under the same key, which the orchestrator drops", async () => {
    const stub = stubOrchestrator(ok)
    stripeAnswers("requires_capture")
    const first = await deliver(stub, completed("evt_replayed"))
    const again = await deliver(stub, completed("evt_replayed"))
    expect([first.status, again.status]).toEqual([200, 200])
    expect(
      stub.calls.map((c) => c.request.headers.get("idempotency-key"))
    ).toEqual(["evt_replayed", "evt_replayed"])
  })

  it("asks Stripe to retry only when the orchestrator's outcome is unknown", async () => {
    stripeAnswers("requires_capture")
    const down = stubOrchestrator(() =>
      Response.json(
        {
          class: "transient",
          code: "orchestrator.unavailable",
          message: "down",
          detail: {},
          occurred_at: new Date().toISOString(),
        },
        { status: 503 }
      )
    )
    expect((await deliver(down, completed())).status).toBe(503)
    const gone = stubOrchestrator(() =>
      Response.json(
        {
          class: "resource",
          code: "domain.not_found",
          message: "No such domain.",
          detail: {},
          occurred_at: new Date().toISOString(),
        },
        { status: 404 }
      )
    )
    expect((await deliver(gone, completed())).status).toBe(200)
  })

  it("says nothing of a completed Checkout whose hold is not authorised", async () => {
    const stub = stubOrchestrator(ok)
    stripeAnswers("requires_payment_method")
    expect((await deliver(stub, completed())).status).toBe(200)
    expect(stub.calls).toHaveLength(0)
  })

  it("ignores an event without our org and domain in its metadata", async () => {
    const stub = stubOrchestrator(ok)
    stripeAnswers("requires_capture")
    const foreign = completed()
    foreign.data.object.metadata = {} as typeof ours
    expect((await deliver(stub, foreign)).status).toBe(200)
    const garbled = completed()
    garbled.data.object.metadata = { ...ours, domain_id: "not-a-uuid" }
    expect((await deliver(stub, garbled)).status).toBe(200)
    expect(stub.calls).toHaveLength(0)
  })

  it("maps expiry, renewals and the subscription's end", async () => {
    const stub = stubOrchestrator(ok)
    const invoice = (type: string, id: string) => ({
      id,
      type,
      data: {
        object: {
          id: "in_1",
          metadata: {},
          parent: {
            subscription_details: { subscription: "sub_1", metadata: ours },
          },
        },
      },
    })
    const subscription = (type: string, id: string, status: string) => ({
      id,
      type,
      data: { object: { id: "sub_1", status, metadata: ours } },
    })
    const events = [
      {
        id: "evt_expired",
        type: "checkout.session.expired",
        data: { object: { id: "cs_test_1", metadata: ours } },
      },
      invoice("invoice.paid", "evt_paid"),
      invoice("invoice.payment_failed", "evt_failed"),
      subscription("customer.subscription.updated", "evt_active", "active"),
      subscription("customer.subscription.updated", "evt_unpaid", "unpaid"),
      subscription("customer.subscription.deleted", "evt_deleted", "canceled"),
      {
        id: "evt_other",
        type: "customer.created",
        data: { object: { id: "cus_1", metadata: ours } },
      },
    ]
    for (const event of events) {
      expect((await deliver(stub, event)).status).toBe(200)
    }
    const base = { domain_id: DOMAIN }
    expect(stub.calls.map((c) => c.body)).toEqual([
      {
        type: "expired",
        event_id: "evt_expired",
        ...base,
        checkout_session: "cs_test_1",
      },
      {
        type: "renewal_paid",
        event_id: "evt_paid",
        ...base,
        subscription: "sub_1",
        invoice: "in_1",
      },
      {
        type: "renewal_failed",
        event_id: "evt_failed",
        ...base,
        subscription: "sub_1",
        invoice: "in_1",
      },
      {
        type: "subscription_ended",
        event_id: "evt_unpaid",
        ...base,
        subscription: "sub_1",
      },
      {
        type: "subscription_ended",
        event_id: "evt_deleted",
        ...base,
        subscription: "sub_1",
      },
    ])
  })
})
