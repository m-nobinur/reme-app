import {
  BUY_REFUSALS,
  DomainCheckout,
  DomainCheckoutRequest,
  DomainPaymentEvent,
  DomainPrice,
  DomainStripe,
  idempotencyKey,
  Uuid,
} from "@workspace/contracts"
import {
  domains,
  eq,
  memberships,
  orgs,
  sql,
  type Tenancy,
  users,
} from "@workspace/db"
import { bridge, type Owner, relay } from "./changes.ts"
import {
  boundedBody,
  failure,
  invalid,
  keyMissing,
  readBody,
  tooLarge,
} from "./http.ts"
import { StripeFailed, stripe, verifyStripeSignature } from "./stripe.ts"

/**
 * The buy path's api half (custom-domains plan, "Buy and pay path"): the
 * owner's embedded Checkout for a domain the orchestrator holds as
 * `awaiting_payment`, and Stripe's webhook, verified here and handed to the
 * orchestrator, which owns the domains row and every state it moves to.
 * The amount comes from the row's price, never from the client or the model.
 */

/** Whether this Worker can take a payment: off until its Stripe keys are set. */
export const buyConfigured = (env: Env) =>
  Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET)

export const buyUnavailable = () => failure(409, BUY_REFUSALS.buy_unavailable)

/** Whether the session's person is the org's owner, as account deletion checks it. */
export async function isOrgOwner(kit: Tenancy, owner: Owner): Promise<boolean> {
  const [own] = await kit.withOrg({ orgId: owner.orgId }, (db) =>
    db
      .select({ role: memberships.role })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        sql`${memberships.status} = 'active' and ${users.workosUserId} = ${owner.session.workosUserId}`
      )
  )
  return own?.role === "owner"
}

export const notOwner = (verb: "buy" | "remove") =>
  failure(403, {
    class: "permission",
    code: "domain.not_owner",
    message: `Only the owner can ${verb} a domain.`,
    detail: {},
  })

const noPurchase = () =>
  failure(404, {
    class: "resource",
    code: "domain.not_found",
    message: "This business is not buying a domain by that name.",
    detail: {},
  })

/** The org's newest purchase of `name`, under its RLS. */
async function newest(kit: Tenancy, orgId: string, name: string) {
  const [row] = await kit.withOrg({ orgId }, (db) =>
    db
      .select({
        id: domains.id,
        name: domains.name,
        state: domains.state,
        price: domains.price,
        stripe: domains.stripe,
        registration: domains.registration,
      })
      .from(domains)
      .where(sql`${eq(domains.name, name)} and ${domains.origin} = 'purchased'`)
      .orderBy(sql`${domains.createdAt} desc`)
      .limit(1)
  )
  return row ?? null
}

/**
 * Checkout's own floor is 30 minutes after it creates the session, so a
 * minute more keeps our clock and the trip to Stripe inside it.
 */
const CHECKOUT_TTL_S = 31 * 60

/** Tags our sessions in Stripe's dashboard; the suffix is Stripe's ask. */
const INTEGRATION = "reme-domain-buy-qhzvmkta"

type Session = {
  id: string
  status: "open" | "complete" | "expired"
  client_secret: string | null
  expires_at: number
}

/**
 * The org's Stripe Customer, made once and kept in `orgs.stripe_customer_id`.
 * Stripe's idempotency key keeps two first purchases at once to one
 * Customer for its 24 hours; the conditional update keeps the first one
 * stored after that.
 */
async function customerOf(env: Env, kit: Tenancy, orgId: string) {
  const [org] = await kit.withOrg({ orgId }, (db) =>
    db
      .select({ name: orgs.name, customer: orgs.stripeCustomerId })
      .from(orgs)
      .where(eq(orgs.id, orgId))
  )
  if (!org) throw new Error("the resolved org has no row")
  if (org.customer) return org.customer
  const made = await stripe<{ id: string }>(
    env.STRIPE_SECRET_KEY as string,
    "customers",
    { name: org.name, metadata: { org_id: orgId } },
    `customer:${orgId}`
  )
  const [kept] = await kit.withOrg({ orgId }, (db) =>
    db
      .update(orgs)
      .set({
        stripeCustomerId: sql`coalesce(${orgs.stripeCustomerId}, ${made.id})`,
      })
      .where(eq(orgs.id, orgId))
      .returning({ customer: orgs.stripeCustomerId })
  )
  return kept?.customer ?? made.id
}

/**
 * Where Checkout sends the owner after a redirect-based payment, the only
 * kind that leaves the chat: the web's return page, which fulfils nothing.
 * Local dev points `WEB_ORIGIN` at the local web in `.dev.vars`.
 */
function returnUrl(env: Env, name: string) {
  const back = new URL("/app/domains/return", env.WEB_ORIGIN)
  back.searchParams.set("name", name)
  // Stripe fills the placeholder; URLSearchParams would escape its braces.
  return `${back.href}&session_id={CHECKOUT_SESSION_ID}`
}

/**
 * `POST /domains/{name}/checkout`: the embedded Checkout for the org's
 * newest purchase of that name while it is `awaiting_payment`, the owner
 * only. The body is the registrant as the card shows it or the owner
 * corrected it; the orchestrator stores it with the session and checks it
 * against the name's ending. A session still open for the row is handed
 * back rather than replaced, so a reopened card leaves no second one to
 * expire under it. Otherwise a new one: a manual capture hold (the Workflow
 * captures after registering), the card saved for the renewal
 * subscription, dynamic payment methods, and `org_id` with `domain_id` in
 * every metadata the webhook reads back.
 */
export async function checkout(
  request: Request,
  env: Env,
  kit: Tenancy,
  owner: Owner,
  name: string
): Promise<Response> {
  const key = idempotencyKey(request)
  if (!key) return keyMissing()
  const details = DomainCheckoutRequest.safeParse(await readBody(request))
  if (!details.success) return invalid(details.error.issues)
  if (!buyConfigured(env)) return buyUnavailable()
  if (!(await isOrgOwner(kit, owner))) return notOwner("buy")
  const row = await newest(kit, owner.orgId, name)
  if (!row) return noPurchase()
  if (row.state !== "awaiting_payment") {
    return failure(409, {
      class: "validation",
      code: "domain.not_awaiting_payment",
      message: "That domain is not waiting for a payment.",
      detail: { state: row.state },
    })
  }
  const price = DomainPrice.parse(row.price)
  const secretKey = env.STRIPE_SECRET_KEY as string
  const held = DomainStripe.partial().safeParse(row.stripe ?? {}).data
  try {
    let session: Session | null = null
    if (held?.checkout_session) {
      const open = await stripe<Session>(
        secretKey,
        `checkout/sessions/${held.checkout_session}`
      )
      if (open.status === "open" && open.client_secret) session = open
    }
    const customer = held?.customer ?? (await customerOf(env, kit, owner.orgId))
    const metadata = { org_id: owner.orgId, domain_id: row.id }
    session ??= await stripe<Session>(
      secretKey,
      "checkout/sessions",
      {
        mode: "payment",
        ui_mode: "embedded_page",
        redirect_on_completion: "if_required",
        return_url: returnUrl(env, row.name),
        customer,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "gbp",
              unit_amount: price.retail_gbp * 100,
              product_data: { name: `${row.name}, 1 year` },
            },
          },
        ],
        payment_intent_data: {
          capture_method: "manual",
          setup_future_usage: "off_session",
          metadata,
        },
        metadata,
        expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_TTL_S,
        integration_identifier: INTEGRATION,
      },
      `checkout:${row.id}:${key}`
    )
    const told = await bridge(
      env,
      owner,
      `/domains/${row.id}/checkout-session`,
      {
        body: { session_id: session.id, customer, ...details.data },
        key: `checkout:${row.id}:${key}`,
      }
    )
    if (told.status >= 300) return relay(told, () => null)
    return Response.json(
      DomainCheckout.parse({
        name: row.name,
        price_gbp: price.retail_gbp,
        client_secret: session.client_secret,
        expires_at: new Date(session.expires_at * 1000).toISOString(),
      })
    )
  } catch (error) {
    if (!(error instanceof StripeFailed)) throw error
    console.error(
      JSON.stringify({
        code: "stripe.checkout_failed",
        status: error.status,
        stripe: error.code,
      })
    )
    return failure(503, {
      class: "transient",
      code: "stripe.unavailable",
      message: "The payment page could not be opened. Try again.",
      detail: {},
    })
  }
}

/** The parts of a Stripe event this file reads. */
type StripeEvent = {
  id: string
  type: string
  data: {
    object: {
      id: string
      status?: string
      payment_intent?: string | null
      metadata?: Record<string, string> | null
      parent?: {
        subscription_details?: {
          subscription?: string | null
          metadata?: Record<string, string> | null
        } | null
      } | null
    }
  }
}

const ours = (told: unknown) => DomainPaymentEvent.safeParse(told).data ?? null

/**
 * What the orchestrator is told for a verified event, or null for one that
 * asks nothing of it. A completed Checkout counts only once its hold is
 * authorised, which Stripe says by the PaymentIntent's `requires_capture`.
 * An invoice carries its subscription's metadata under `parent`.
 */
async function forwarded(
  env: Env,
  event: StripeEvent
): Promise<DomainPaymentEvent | null> {
  const object = event.data.object
  const invoiceOf = object.parent?.subscription_details
  const metadata = invoiceOf?.metadata ?? object.metadata ?? {}
  const base = { event_id: event.id, domain_id: metadata.domain_id }
  switch (event.type) {
    case "checkout.session.completed": {
      if (!object.payment_intent) return null
      const intent = await stripe<{ status: string }>(
        env.STRIPE_SECRET_KEY as string,
        `payment_intents/${object.payment_intent}`
      )
      if (intent.status !== "requires_capture") return null
      return ours({
        type: "paid",
        ...base,
        checkout_session: object.id,
        payment_intent: object.payment_intent,
      })
    }
    case "checkout.session.expired":
      return ours({ type: "expired", ...base, checkout_session: object.id })
    case "invoice.paid":
    case "invoice.payment_failed":
      return ours({
        type: event.type === "invoice.paid" ? "renewal_paid" : "renewal_failed",
        ...base,
        subscription: invoiceOf?.subscription,
        invoice: object.id,
      })
    case "customer.subscription.updated":
      if (object.status !== "unpaid") return null
      return ours({
        type: "subscription_ended",
        ...base,
        subscription: object.id,
      })
    case "customer.subscription.deleted":
      return ours({
        type: "subscription_ended",
        ...base,
        subscription: object.id,
      })
    default:
      return null
  }
}

const received = () => Response.json({ received: true })

/**
 * `POST /webhooks/stripe`. The signature is checked on the raw body with
 * `STRIPE_WEBHOOK_SECRET` before anything is parsed. The org and the
 * domain come from the event's metadata, which only our own Checkout and
 * subscription calls write and Stripe signs; the orchestrator reaches the
 * row under that org's RLS, so a wrong pair finds nothing. It is keyed by
 * the event id and records each one, so a replayed event does nothing
 * twice. A definite answer, or an event that is not ours, is a 200 so
 * Stripe stops; only an outcome nobody knows is a 503 for Stripe to retry.
 */
export async function stripeWebhook(
  request: Request,
  env: Env
): Promise<Response> {
  if (!buyConfigured(env)) {
    return failure(404, {
      class: "validation",
      code: "route.not_found",
      message: "No route matches this path.",
      detail: { pathname: "/webhooks/stripe" },
    })
  }
  const bytes = await boundedBody(request)
  if (!bytes) return tooLarge()
  const raw = new TextDecoder().decode(bytes)
  const signature = request.headers.get("stripe-signature")
  if (
    !(await verifyStripeSignature(
      raw,
      signature,
      env.STRIPE_WEBHOOK_SECRET as string
    ))
  ) {
    return failure(400, {
      class: "permission",
      code: "stripe.signature_invalid",
      message: "This request is not signed by Stripe.",
      detail: {},
    })
  }
  const event = JSON.parse(raw) as StripeEvent
  const object = event.data.object
  const orgId =
    object.parent?.subscription_details?.metadata?.org_id ??
    object.metadata?.org_id
  if (!Uuid.safeParse(orgId).success) return received()
  let told: DomainPaymentEvent | null
  try {
    told = await forwarded(env, event)
  } catch (error) {
    if (!(error instanceof StripeFailed)) throw error
    return failure(503, {
      class: "transient",
      code: "stripe.unavailable",
      message: "Stripe did not answer. Retry.",
      detail: {},
    })
  }
  if (!told) return received()
  // No owner sent this: the bridge's person and session say it was Stripe.
  const result = await bridge(
    env,
    {
      orgId: orgId as string,
      session: {
        workosUserId: "stripe",
        sessionId: event.id,
        impersonated: false,
        email: "",
        name: null,
      },
    },
    `/domains/${told.domain_id}/stripe`,
    { body: told, key: event.id }
  )
  if (result.status >= 500) return relay(result, () => null)
  if (result.status >= 300) {
    console.error(
      JSON.stringify({
        code: "stripe.event_refused",
        status: result.status,
        type: event.type,
      })
    )
  }
  return received()
}
