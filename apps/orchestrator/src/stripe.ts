/**
 * The orchestrator's Stripe calls for a bought domain, over fetch: read,
 * capture or cancel the Checkout's hold, and the yearly renewal
 * Subscription. Checkout Sessions and the webhook are the api's. Every write
 * carries an idempotency key built from the domain id, so a retried step
 * never captures, cancels or subscribes twice.
 *
 * shortcut: one test-mode secret key per Worker in place of the plan's
 * restricted keys split by Worker; make the restricted keys when live keys
 * are created.
 */
import { DomainError } from "./domains.ts"

export type StripeEnv = { STRIPE_SECRET_KEY?: string }

const STRIPE_API = "https://api.stripe.com/v1"
/** Pinned so a dashboard upgrade never changes what these calls get back. */
export const STRIPE_VERSION = "2026-08-26.dahlia"
export const STRIPE_TIMEOUT_MS = 10_000

/** Stripe's form encoding: `a[b][0]=c`. */
export function form(value: unknown, prefix = ""): string[] {
  if (value === undefined || value === null) return []
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      form(v, prefix ? `${prefix}[${k}]` : k)
    )
  }
  return [`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`]
}

async function stripe<T>(
  env: StripeEnv,
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  idempotencyKey?: string
): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new DomainError("stripe.not_configured")
  const response = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "stripe-version": STRIPE_VERSION,
      ...(body && { "content-type": "application/x-www-form-urlencoded" }),
      ...(idempotencyKey && { "idempotency-key": idempotencyKey }),
    },
    body: body ? form(body).join("&") : undefined,
    signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
  })
  const json = (await response.json().catch(() => ({}))) as T & {
    error?: { code?: string; type?: string }
  }
  // Stripe's own outage or rate limit: a retry may succeed.
  if (response.status >= 500 || response.status === 429)
    throw new DomainError("stripe.unavailable")
  if (!response.ok) {
    throw new DomainError(
      `stripe.${json.error?.code ?? json.error?.type ?? response.status}`
    )
  }
  return json
}

export type PaymentIntent = {
  id: string
  status: string
  amount: number
  amount_capturable: number
  currency: string
  customer: string | null
  payment_method: string | null
  metadata: Record<string, string>
}

export const getPaymentIntent = (env: StripeEnv, id: string) =>
  stripe<PaymentIntent>(
    env,
    "GET",
    `/payment_intents/${encodeURIComponent(id)}`
  )

/**
 * The PaymentIntent, refused unless its metadata names this domain: our own
 * Checkout writes `domain_id` there, so an id from anywhere else can never
 * capture or release another purchase.
 */
async function ours(
  env: StripeEnv,
  id: string,
  domainId: string
): Promise<PaymentIntent> {
  const pi = await getPaymentIntent(env, id)
  if (pi.metadata.domain_id !== domainId)
    throw new DomainError("stripe.payment_mismatch")
  return pi
}

/** Takes the held amount. A PaymentIntent already captured is done. */
export async function capturePayment(
  env: StripeEnv,
  id: string,
  domainId: string
): Promise<PaymentIntent> {
  const pi = await ours(env, id, domainId)
  if (pi.status === "succeeded") return pi
  return stripe<PaymentIntent>(
    env,
    "POST",
    `/payment_intents/${encodeURIComponent(id)}/capture`,
    {},
    `domain-capture-${domainId}`
  )
}

/**
 * Releases the hold; nothing is charged. One already cancelled is done, and
 * one already captured is left alone and reported, never refunded here.
 */
export async function releasePayment(
  env: StripeEnv,
  id: string,
  domainId: string
): Promise<"released" | "captured"> {
  const pi = await ours(env, id, domainId)
  if (pi.status === "canceled") return "released"
  if (pi.status === "succeeded") return "captured"
  await stripe<PaymentIntent>(
    env,
    "POST",
    `/payment_intents/${encodeURIComponent(id)}/cancel`,
    {},
    `domain-cancel-${domainId}`
  )
  return "released"
}

/** The Product a TLD's renewals bill under, made once with our own id. */
export async function ensureProduct(
  env: StripeEnv,
  tld: string
): Promise<string> {
  const id = `reme_domain_${tld.replace(/\./g, "_")}`
  try {
    await stripe(env, "GET", `/products/${id}`)
    return id
  } catch (error) {
    if (
      !(
        error instanceof DomainError && error.name === "stripe.resource_missing"
      )
    )
      throw error
  }
  await stripe(
    env,
    "POST",
    "/products",
    { id, name: `.${tld} domain renewal` },
    `domain-product-${id}`
  )
  return id
}

/** Days before expiry the renewal invoice lands, so Stripe's retries end before Cloudflare charges us. */
export const RENEW_DAYS_BEFORE = 50

/**
 * The yearly renewal: billed first at expiry minus 50 days, nothing for the
 * time up to then (year one was the captured hold), on the card the owner
 * paid with. Its metadata names the domain for the webhook.
 */
export async function createRenewal(
  env: StripeEnv,
  input: {
    orgId: string
    domainId: string
    customer: string
    paymentMethod: string
    tld: string
    pence: number
    expiresAt: string
  }
): Promise<{ id: string; status: string }> {
  const product = await ensureProduct(env, input.tld)
  const anchor = Math.floor(
    (Date.parse(input.expiresAt) - RENEW_DAYS_BEFORE * 86_400_000) / 1000
  )
  return stripe(
    env,
    "POST",
    "/subscriptions",
    {
      customer: input.customer,
      default_payment_method: input.paymentMethod,
      items: [
        {
          price_data: {
            currency: "gbp",
            product,
            unit_amount: input.pence,
            recurring: { interval: "year" },
          },
        },
      ],
      billing_cycle_anchor: anchor,
      proration_behavior: "none",
      metadata: { org_id: input.orgId, domain_id: input.domainId },
    },
    `domain-renewal-${input.domainId}`
  )
}

export type Invoice = {
  id: string
  hosted_invoice_url: string | null
  next_payment_attempt: number | null
}

export const getInvoice = (env: StripeEnv, id: string) =>
  stripe<Invoice>(env, "GET", `/invoices/${encodeURIComponent(id)}`)
