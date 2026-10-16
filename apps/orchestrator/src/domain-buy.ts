import {
  BUY_REFUSALS,
  BuyDomainInput,
  type BuyDomainOutput,
  DOMAIN_PRICES,
  type DomainOffer,
  DomainPaymentEvent,
  DomainPrice,
  DomainRegistration,
  DomainStripe,
  FindDomainInput,
  type FindDomainOutput,
  RegistrantDetails,
  sellableTld,
  Uuid,
} from "@workspace/contracts"
import {
  appendEvent,
  currentFacts,
  domains,
  eq,
  events,
  type OrgScopedDb,
  pgCode,
  sql,
  type Tenancy,
} from "@workspace/db"
import {
  domainInstanceId,
  eventKey,
  moveTo,
  normalizeName,
  postStatus,
  type Refusal,
  reaches,
  readClaim,
  refuse,
  type Say,
  start,
} from "./domain-flow.ts"
import { DomainError } from "./domains.ts"
import { activeDeployment } from "./publish.ts"
import {
  attachHostname,
  CHECK_MAX,
  type Checked,
  candidates,
  checkDomains,
  ensureZone,
  getRegistration,
  type Registrant,
  type RegistrationStatus,
  register,
  registrantProblem,
  registrantRules,
  registrarLive,
  registrationStatus,
  searchDomains,
  sellable,
  setAutoRenew,
} from "./registrar.ts"
import {
  capturePayment,
  createRenewal,
  getInvoice,
  getPaymentIntent,
  releasePayment,
} from "./stripe.ts"

/**
 * Buying a domain (custom-domains plan, "Buy and pay path"): the owner
 * routes the api calls and the step bodies of `DomainWorkflow`'s buy branch.
 * The owner pays first, as a hold; we register, then capture, or release the
 * hold so nobody is charged for a domain they did not get. Postgres holds the
 * purchase's state, Stripe the money and Cloudflare the registration; the
 * registrant's details sit on the row only while the purchase is open.
 */

type DomainRow = typeof domains.$inferSelect

/** The row's registration with `set` merged, checked against the contract. */
const merged = (row: DomainRow, set: Partial<DomainRegistration>) =>
  DomainRegistration.parse({
    ...(row.registration as DomainRegistration | null),
    ...set,
  })

/** How a purchase ended, as `registration.outcome` keeps it for the card. */
export type Outcome =
  | "registered"
  | "test_registered"
  | "payment_released"
  | "price_changed"
  | "unavailable"
  | "expired"

const fromEnvelope = (
  status: Refusal["status"],
  body: (typeof BUY_REFUSALS)[keyof typeof BUY_REFUSALS]
) => refuse(status, body.class, body.code, body.message)

const registrarDown = () =>
  refuse(
    503,
    "transient",
    "registrar.unavailable",
    "I couldn't reach the domain registry just now. Try again in a minute."
  )

/** Stripe's or Cloudflare's own outage: worth another try, unlike a refusal. */
const transient = (error: unknown) =>
  !(error instanceof DomainError) ||
  error.name === "stripe.unavailable" ||
  /^cloudflare\.(5\d\d|429)$/.test(error.name)

// ---------------------------------------------------------------------------
// Find
// ---------------------------------------------------------------------------

/** The business facts the ranker reads. */
async function rankFacts(db: OrgScopedDb, query?: string) {
  const rows = await currentFacts(db)
  const value = (key: string) =>
    rows.find((r) => r.key === key)?.value as
      | Record<string, unknown>
      | undefined
  const text = (v: unknown) => (typeof v === "string" ? v : undefined)
  return {
    name: query || text(value("business.name")?.name) || "",
    town:
      text(value("service_area.radius")?.centre) ??
      text(value("service_area.text")?.text),
    trade: text(value("business.industry")?.name),
  }
}

/**
 * `POST /domains/find`: names free to register now, at the price table's
 * price, best first. The ranker's names from the business facts (or the
 * owner's words), plus the registrar's own suggestions for those words, in
 * one authoritative check; a name the configured registrar will not sell is
 * never offered. Needs no Stripe: finding is free.
 */
export async function find(
  env: Env,
  kit: Tenancy,
  orgId: string,
  body: unknown
): Promise<Refusal | FindDomainOutput> {
  const input = FindDomainInput.safeParse(body ?? {})
  if (!input.success)
    return refuse(
      400,
      "validation",
      "domain.invalid",
      "That search isn't one I can run."
    )
  const facts = await kit.withOrg({ orgId }, (db) =>
    rankFacts(db, input.data.query)
  )
  const ranked = candidates(facts)
  const why = new Map(ranked.map((r) => [r.name, r.why]))
  const suggested = input.data.query
    ? await searchDomains(env, input.data.query).catch(() => [])
    : []
  // Best first: the ranker's order, then the registrar's suggestions.
  const names = [
    ...new Set([...ranked.map((r) => r.name), ...suggested]),
  ].slice(0, CHECK_MAX)
  let checked: Checked[]
  try {
    checked = await checkDomains(env, names)
  } catch {
    return registrarDown()
  }
  const order = new Map(names.map((n, i) => [n, i]))
  const offers: DomainOffer[] = checked
    .filter((c) => sellable(c) !== null)
    .sort((a, b) => (order.get(a.name) ?? 0) - (order.get(b.name) ?? 0))
    .flatMap((c) => {
      const tld = sellableTld(c.name)
      return tld
        ? [
            {
              name: c.name,
              price_gbp_year: DOMAIN_PRICES[tld].retail_gbp,
              why: why.get(c.name) ?? "close to what you asked for",
            },
          ]
        : []
    })
  const [best, ...options] = offers
  if (!best) return fromEnvelope(409, BUY_REFUSALS.unavailable)
  return { outcome: "found", best, options: options.slice(0, 4) }
}

// ---------------------------------------------------------------------------
// Buy
// ---------------------------------------------------------------------------

/**
 * The phone as Cloudflare takes it, `+{country code}.{number}`. The country
 * code is read from ITU's table: 1 and 7 are one digit, the listed ones two,
 * every other three.
 */
export function registrarPhone(e164: string): string {
  const digits = e164.replace(/^\+/, "")
  const two = /^(2[07]|3[0-469]|4[0-9]|5[1-8]|6[0-6]|8[1246]|9[0-58])/.test(
    digits
  )
  const length = /^[17]/.test(digits) ? 1 : two ? 2 : 3
  return `+${digits.slice(0, length)}.${digits.slice(length)}`
}

/** The registrant as Cloudflare's contact, county or city standing in for `state`. */
export function toRegistrant(
  details: RegistrantDetails["registrant"]
): Registrant {
  const { address } = details
  return {
    name: details.name,
    ...(details.organization && { organization: details.organization }),
    email: details.email,
    phone: registrarPhone(details.phone),
    address: {
      street: address.street,
      city: address.city,
      state: address.state ?? address.city,
      postal_code: address.postal_code,
      country_code: address.country_code,
    },
  }
}

/**
 * The name's live price, or the refusal: not free now (`unavailable`) or
 * over the TLD's cap (`price_changed`).
 */
async function priceNow(
  env: Env,
  name: string
): Promise<Refusal | { price: DomainPrice }> {
  const tld = sellableTld(name)
  if (!tld) return fromEnvelope(409, BUY_REFUSALS.unavailable)
  let found: Checked | undefined
  try {
    ;[found] = await checkDomains(env, [name])
  } catch {
    return registrarDown()
  }
  const cost = found ? sellable(found) : null
  if (cost === null)
    return found?.registrable && found.tier !== "premium"
      ? fromEnvelope(409, BUY_REFUSALS.price_changed)
      : fromEnvelope(409, BUY_REFUSALS.unavailable)
  return {
    price: { tld, retail_gbp: DOMAIN_PRICES[tld].retail_gbp, cost_usd: cost },
  }
}

/** The details checked against the extension's own rules, or the refusal. */
async function checkRegistrant(
  env: Env,
  name: string,
  details: RegistrantDetails
): Promise<Refusal | null> {
  const tld = sellableTld(name)
  if (!tld) return fromEnvelope(409, BUY_REFUSALS.unavailable)
  try {
    const rules = await registrantRules(env, tld)
    return registrantProblem(rules, details)
      ? fromEnvelope(400, BUY_REFUSALS.registrant_invalid)
      : null
  } catch (error) {
    if (transient(error)) return registrarDown()
    throw error
  }
}

/** Open purchases one org may hold at once (plan, Security: squatting). */
export const MAX_OPEN_PURCHASES = 3

/**
 * `POST /domains/buy`, the `buy_domain` tool: a name free now and under the
 * cap, details that suit its extension, a published site, and then the
 * `awaiting_payment` row with the price the Checkout will charge. No money
 * moves. The same org asking again for a name it is buying gets the row with
 * its price and details refreshed.
 *
 * shortcut: the plan's account-wide cap of 10 registrations a day needs a
 * cross-org count no route here may make; add it as a definer once buying
 * goes live.
 */
export async function buy(
  env: Env,
  kit: Tenancy,
  orgId: string,
  body: unknown
): Promise<Refusal | { status: 200 | 201; output: BuyDomainOutput }> {
  if (!env.STRIPE_SECRET_KEY)
    return fromEnvelope(409, BUY_REFUSALS.buy_unavailable)
  const parsed = BuyDomainInput.safeParse(body)
  const name = normalizeName((body as { name?: unknown } | null)?.name)
  if (!name || !sellableTld(name))
    return fromEnvelope(409, BUY_REFUSALS.unavailable)
  if (!parsed.success) return fromEnvelope(400, BUY_REFUSALS.registrant_invalid)
  const priced = await priceNow(env, name)
  if ("refused" in priced) return priced
  const invalid = await checkRegistrant(env, name, parsed.data)
  if (invalid) return invalid
  const { registrant, registrant_type, company_number } = parsed.data
  const held = { registrant, registrant_type, company_number }
  let created: Refusal | { id: string } | false
  try {
    created = await kit.withOrg({ orgId }, async (db) => {
      // Key 4, as `connect`: one claim per org at a time.
      await db.execute(
        sql`select pg_advisory_xact_lock(4, hashtext(${orgId}::text))`
      )
      const [open] = await db
        .select({
          id: domains.id,
          state: domains.state,
          origin: domains.origin,
        })
        .from(domains)
        .where(
          sql`${domains.name} = ${name} and ${domains.state} in ('awaiting_payment', 'awaiting_dns', 'verifying', 'active')`
        )
      if (open?.state === "awaiting_payment") {
        await db
          .update(domains)
          .set({ price: priced.price, registrant: held })
          .where(eq(domains.id, open.id))
        return false
      }
      if (open)
        return refuse(
          409,
          "resource",
          "domain.in_use",
          `${name} is already on this site.`
        )
      if (!(await activeDeployment(db, orgId)))
        return refuse(
          409,
          "resource",
          "site.not_published",
          "Publish the site first, then buy a domain for it."
        )
      // An unpaid purchase holds its name from every other org, so an org
      // holds few at once, each abandoned by its Workflow if never paid.
      const [buying] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(domains)
        .where(
          sql`${domains.origin} = 'purchased' and ${domains.state} in ('awaiting_payment', 'verifying')`
        )
      if ((buying?.n ?? 0) >= MAX_OPEN_PURCHASES)
        return refuse(
          409,
          "resource",
          "domain.too_many_pending",
          "There are already three domain purchases open. Finish or wait for one first."
        )
      const [row] = await db
        .insert(domains)
        .values({
          orgId,
          siteId: orgId,
          name,
          primaryHost: name,
          origin: "purchased",
          method: "purchased",
          state: "awaiting_payment",
          onCloudflare: true,
          price: priced.price,
          registrant: held,
          registration: DomainRegistration.parse({
            sandbox: !registrarLive(env),
            years: 1,
            auto_renew: true,
            ...(registrant_type && { registrant_type }),
          }),
        })
        .returning({ id: domains.id })
      if (!row) throw new Error("domains insert returned nothing")
      await appendEvent(db, {
        orgId,
        assignmentId: null,
        staffId: null,
        type: "domain.buy_requested",
        payload: { domain_id: row.id, name, price: priced.price },
      })
      return row
    })
  } catch (error) {
    // Another org holds the name live: the unique index says so.
    if (pgCode(error) === "23505")
      return fromEnvelope(409, BUY_REFUSALS.unavailable)
    throw error
  }
  if (created && "refused" in created) return created
  // Started now, so a purchase nobody pays for is abandoned and frees its name.
  if (created) await start(env, orgId, created.id, true)
  return {
    status: created ? 201 : 200,
    output: {
      outcome: "awaiting_payment",
      name,
      price_gbp: priced.price.retail_gbp,
      checkout: "embedded",
    },
  }
}

// ---------------------------------------------------------------------------
// Checkout and Stripe's events
// ---------------------------------------------------------------------------

async function readPurchase(kit: Tenancy, orgId: string, domainId: string) {
  if (!Uuid.safeParse(domainId).success) return undefined
  const [row] = await kit.withOrg({ orgId }, (db) =>
    db
      .select()
      .from(domains)
      .where(
        sql`${domains.id} = ${domainId} and ${domains.origin} = 'purchased'`
      )
  )
  return row
}

const noPurchase = () =>
  refuse(404, "resource", "domain.not_found", "No purchase with that id here.")

const CheckoutSession = RegistrantDetails.extend({
  session_id: DomainStripe.shape.checkout_session,
  customer: DomainStripe.shape.customer,
})

/**
 * `POST /domains/{id}/checkout-session`: the api made (or reused) the
 * Checkout Session for an `awaiting_payment` row. The session, the customer
 * and the owner's latest details are stored, and the Workflow started, which
 * then waits for the payment. Details that do not suit the extension are a
 * 400, and the api never shows that session.
 */
export async function checkoutSession(
  env: Env,
  kit: Tenancy,
  orgId: string,
  domainId: string,
  body: unknown
): Promise<Refusal | null> {
  const input = CheckoutSession.safeParse(body)
  if (!input.success) return fromEnvelope(400, BUY_REFUSALS.registrant_invalid)
  const row = await readPurchase(kit, orgId, domainId)
  if (!row) return noPurchase()
  const invalid = await checkRegistrant(env, row.name, input.data)
  if (invalid) return invalid
  const { session_id, customer, registrant, registrant_type, company_number } =
    input.data
  const stored = await kit.withOrg({ orgId }, (db) =>
    db
      .update(domains)
      .set({
        stripe: { customer, checkout_session: session_id },
        registrant: { registrant, registrant_type, company_number },
      })
      .where(
        sql`${domains.id} = ${domainId} and ${domains.state} = 'awaiting_payment'`
      )
      .returning({ id: domains.id })
  )
  if (stored.length === 0)
    return refuse(
      409,
      "validation",
      "domain.not_awaiting_payment",
      "That domain is not waiting for a payment."
    )
  await start(env, orgId, domainId, true)
  return null
}

/**
 * The purchase closed: its state, the outcome kept in `registration` for the
 * card, and the registrant's details dropped in the same update. Only from a
 * state in `from`, so a replay moves nothing twice.
 */
async function close(
  db: OrgScopedDb,
  row: DomainRow,
  to: "failed" | "abandoned" | "removed",
  from: readonly ("awaiting_payment" | "verifying")[],
  outcome: Outcome,
  extra: Partial<DomainRegistration> = {}
): Promise<boolean> {
  return moveTo(
    db,
    row,
    to,
    from,
    {
      registrant: null,
      registration: merged(row, { ...extra, outcome }),
      ...(to === "removed" && { removedAt: new Date() }),
    },
    { type: `domain.${outcome}`, payload: { domain_id: row.id } }
  )
}

/** The org's domain's registration, merged and stored. */
async function setRegistration(
  kit: Tenancy,
  orgId: string,
  row: DomainRow,
  set: Partial<DomainRegistration>
) {
  await kit.withOrg({ orgId }, (db) =>
    db
      .update(domains)
      .set({ registration: merged(row, set) })
      .where(eq(domains.id, row.id))
  )
}

const day = (iso: unknown) =>
  typeof iso === "string"
    ? new Date(iso).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      })
    : null

/**
 * `POST /domains/{id}/stripe`: a verified Stripe event the api forwarded.
 * A repeat of an event already applied does nothing: each one leaves a
 * `domain.stripe_event` row keyed by its id, written last so an event that
 * failed part way is applied again. Every effect is idempotent on its own
 * too. A refusal (4xx) is a definite no; a 5xx makes Stripe send it again.
 *
 * - `paid`: the hold is checked against the row (our domain, the price, GBP),
 *   the row moves to `verifying` and the Workflow gets `paid`. A hold for a
 *   purchase that already closed is released at once.
 * - `expired`: the row is `abandoned`, only when it is the stored session.
 * - `renewal_paid`: Cloudflare keeps renewing.
 * - `renewal_failed`: one message with the invoice's pay link.
 * - `subscription_ended`: Cloudflare stops renewing, and the owner is told
 *   the date the domain lapses.
 */
export async function paymentEvent(
  env: Env,
  kit: Tenancy,
  orgId: string,
  domainId: string,
  body: unknown
): Promise<Refusal | null> {
  const parsed = DomainPaymentEvent.safeParse(body)
  if (!parsed.success || parsed.data.domain_id !== domainId)
    return refuse(
      400,
      "validation",
      "stripe.event_invalid",
      "That event isn't one we take."
    )
  const event = parsed.data
  const idempotencyKey = await eventKey(event.event_id, "domain.stripe_event")
  const row = await readPurchase(kit, orgId, domainId)
  if (!row) return noPurchase()
  const [seen] = await kit.withOrg({ orgId }, (db) =>
    db
      .select({ id: events.eventId })
      .from(events)
      .where(eq(events.idempotencyKey, idempotencyKey))
      .limit(1)
  )
  if (seen) return null
  await apply(env, kit, orgId, row, event)
  try {
    await kit.withOrg({ orgId }, (db) =>
      appendEvent(db, {
        orgId,
        assignmentId: null,
        staffId: null,
        type: "domain.stripe_event",
        payload: {
          domain_id: domainId,
          event_id: event.event_id,
          type: event.type,
        },
        idempotencyKey,
      })
    )
  } catch (error) {
    if (pgCode(error) !== "23505") throw error
  }
  return null
}

async function apply(
  env: Env,
  kit: Tenancy,
  orgId: string,
  row: DomainRow,
  event: DomainPaymentEvent
): Promise<void> {
  const stripe = DomainStripe.partial().safeParse(row.stripe ?? {}).data ?? {}
  const registration =
    DomainRegistration.partial().safeParse(row.registration ?? {}).data ?? {}
  switch (event.type) {
    case "paid": {
      if (row.state === "verifying" || row.state === "active") return
      if (row.state !== "awaiting_payment") {
        // Closed before the money came: nobody keeps a hold for nothing.
        await releasePayment(env, event.payment_intent, row.id)
        return
      }
      const pi = await getPaymentIntent(env, event.payment_intent)
      const price = DomainPrice.safeParse(row.price).data
      if (
        pi.metadata.domain_id !== row.id ||
        pi.status !== "requires_capture" ||
        pi.currency !== "gbp" ||
        !price ||
        pi.amount !== price.retail_gbp * 100
      ) {
        console.log(
          JSON.stringify({ code: "domain.payment_mismatch", domain_id: row.id })
        )
        return
      }
      const moved = await kit.withOrg({ orgId }, (db) =>
        moveTo(
          db,
          row,
          "verifying",
          ["awaiting_payment"],
          {
            stripe: {
              ...stripe,
              checkout_session: event.checkout_session,
              payment_intent: event.payment_intent,
            },
          },
          {
            type: "domain.paid",
            payload: { domain_id: row.id, amount: pi.amount },
          }
        )
      )
      if (!moved) return
      try {
        const instance = await env.DOMAINS.get(domainInstanceId(row.id))
        await instance.sendEvent({ type: "paid", payload: {} })
      } catch {
        // No instance to tell: start one, which finds the row paid.
        await start(env, orgId, row.id, true)
      }
      return
    }
    case "expired": {
      if (
        row.state !== "awaiting_payment" ||
        stripe.checkout_session !== event.checkout_session
      )
        return
      const closed = await kit.withOrg({ orgId }, (db) =>
        close(db, row, "abandoned", ["awaiting_payment"], "expired")
      )
      if (!closed) return
      try {
        const instance = await env.DOMAINS.get(domainInstanceId(row.id))
        await instance.terminate()
      } catch {
        // Never started, or already ended.
      }
      return
    }
    case "renewal_paid":
      if (row.state !== "active" || registration.auto_renew === true) return
      await setAutoRenew(env, row.name, true)
      await setRegistration(kit, orgId, row, { auto_renew: true })
      return
    case "renewal_failed": {
      if (row.state !== "active") return
      const invoice = await getInvoice(env, event.invoice)
      const by = invoice.next_payment_attempt
        ? day(new Date(invoice.next_payment_attempt * 1000).toISOString())
        : null
      const lapse = day(registration.expires_at)
      await postStatus(kit, orgId, {
        key: `${row.id}:renewal:${event.invoice}`,
        text: `Your card didn't go through for the ${row.name} renewal.${by ? ` I'll try it again on ${by}.` : ""} Pay it with another card${lapse ? ` before ${lapse}, or the domain lapses` : ""}.`,
        ...(invoice.hosted_invoice_url && {
          button: {
            label: "Pay the renewal",
            action: { kind: "open", url: invoice.hosted_invoice_url },
          },
        }),
      })
      return
    }
    case "subscription_ended": {
      if (row.state !== "active") return
      if (registration.auto_renew !== false) {
        await setAutoRenew(env, row.name, false)
        await setRegistration(kit, orgId, row, { auto_renew: false })
      }
      const lapse = day(registration.expires_at)
      await postStatus(kit, orgId, {
        key: `${row.id}:renewal-ended:${event.subscription}`,
        text: `${row.name} won't renew, because its renewal payment stopped.${lapse ? ` It stays yours until ${lapse}, then lapses.` : ""} Ask me if you want to keep it.`,
      })
      return
    }
  }
}

// ---------------------------------------------------------------------------
// Workflow steps
// ---------------------------------------------------------------------------

/** How long the Workflow waits for a payment in one round; the Checkout lives 31 minutes. */
export const PAYMENT_WAIT = "35 minutes"
/** Rounds before an unpaid purchase is abandoned, covering a session made again. */
export const PAYMENT_ROUNDS = 4
/**
 * A card hold lasts 7 days for an online payment; the registration has
 * until 6 to finish, then the hold is released (plan, "Background jobs").
 */
export const HOLD_MS = 6 * 24 * 60 * 60 * 1000

/** Where the purchase is after a wait: paid, still waiting, or closed. */
export async function paymentState(
  kit: Tenancy,
  orgId: string,
  domainId: string
): Promise<"paid" | "waiting" | "gone"> {
  const row = await readPurchase(kit, orgId, domainId)
  if (row?.state === "verifying") return "paid"
  return row?.state === "awaiting_payment" ? "waiting" : "gone"
}

/** No payment in any round: the purchase is abandoned. Nothing was held. */
export async function abandonUnpaid(
  kit: Tenancy,
  orgId: string,
  domainId: string
): Promise<void> {
  const row = await readPurchase(kit, orgId, domainId)
  if (!row) return
  await kit.withOrg({ orgId }, (db) =>
    close(db, row, "abandoned", ["awaiting_payment"], "expired")
  )
}

/**
 * The hold released and the purchase failed with `outcome`, and what to tell
 * the owner. The hold first: a retry after the row moved still finds it.
 */
async function giveUp(
  env: Env,
  kit: Tenancy,
  orgId: string,
  row: DomainRow,
  outcome: "payment_released" | "price_changed" | "unavailable",
  text: string
): Promise<Say | null> {
  const pi = DomainStripe.partial().safeParse(row.stripe ?? {}).data
    ?.payment_intent
  if (pi) await releasePayment(env, pi, row.id)
  await kit.withOrg({ orgId }, (db) =>
    close(db, row, "failed", ["verifying"], outcome)
  )
  return {
    key: `${row.id}:failed`,
    text,
    button: {
      label: "Find me another domain",
      action: { kind: "ask", text: "Find me another domain for my website." },
    },
  }
}

export type Registering =
  | { gone: true }
  | { gone: false; say: Say | null; status?: RegistrationStatus }

/**
 * After the payment: the name checked again, live, and refused when it was
 * taken or its cost rose over the cap (the hold released, the owner told);
 * otherwise the registration started.
 */
export async function startRegistration(
  env: Env,
  kit: Tenancy,
  orgId: string,
  domainId: string
): Promise<Registering> {
  const row = await readPurchase(kit, orgId, domainId)
  if (row?.state !== "verifying") return { gone: true }
  const priced = await priceNow(env, row.name)
  if ("refused" in priced) {
    if (priced.status === 503) throw new DomainError("registrar.unavailable")
    const taken = priced.code === BUY_REFUSALS.unavailable.code
    return {
      gone: false,
      say: await giveUp(
        env,
        kit,
        orgId,
        row,
        taken ? "unavailable" : "price_changed",
        taken
          ? `Someone registered ${row.name} a moment ago, so your card wasn't charged.`
          : `The registry's price for ${row.name} went up, so your card wasn't charged. I can look for another name at our usual price.`
      ),
    }
  }
  const held = RegistrantDetails.safeParse(row.registrant)
  if (!held.success) {
    return {
      gone: false,
      say: await giveUp(
        env,
        kit,
        orgId,
        row,
        "payment_released",
        `I couldn't register ${row.name}: the registration details went missing, so your card wasn't charged. Ask me to try again.`
      ),
    }
  }
  const status = await register(env, {
    name: row.name,
    registrant: toRegistrant(held.data.registrant),
    ...(held.data.registrant_type && {
      registrant_type: held.data.registrant_type,
    }),
    ...(held.data.company_number && {
      company_number: held.data.company_number,
    }),
  })
  return { gone: false, say: null, status }
}

/** The registration's status now, or gone when the purchase closed. */
export async function readRegistration(
  env: Env,
  kit: Tenancy,
  orgId: string,
  domainId: string
): Promise<
  { gone: true } | { gone: false; status: RegistrationStatus; at: number }
> {
  const row = await readPurchase(kit, orgId, domainId)
  if (row?.state !== "verifying") return { gone: true }
  const status = await registrationStatus(env, row.name)
  return { gone: false, status, at: Date.now() }
}

/** The pause before the `n`th status read: seconds at first, then hourly. */
export const registrationWait = (n: number) =>
  (
    [
      "10 seconds",
      "30 seconds",
      "1 minute",
      "2 minutes",
      "5 minutes",
      "10 minutes",
      "30 minutes",
    ] as const
  )[n - 1] ?? "1 hour"

/** The registration failed, or never finished inside the hold: released, failed, said. */
export async function registrationFailed(
  env: Env,
  kit: Tenancy,
  orgId: string,
  domainId: string,
  reason: string
): Promise<Say | null> {
  const row = await readPurchase(kit, orgId, domainId)
  if (row?.state !== "verifying") return null
  console.log(
    JSON.stringify({
      code: "domain.registration_failed",
      domain_id: domainId,
      reason,
    })
  )
  return giveUp(
    env,
    kit,
    orgId,
    row,
    "payment_released",
    `I couldn't register ${row.name}, so your card wasn't charged and the hold on it is released.`
  )
}

/** An alert for something only we can fix; the owner is not asked to act. */
async function alert(
  kit: Tenancy,
  orgId: string,
  domainId: string,
  kind: string
) {
  await kit.withOrg({ orgId }, (db) =>
    appendEvent(db, {
      orgId,
      assignmentId: null,
      staffId: null,
      type: "alert.raised",
      payload: { kind, domain_id: domainId },
    })
  )
}

/**
 * Registered: the hold captured, the registration's expiry kept, and what to
 * tell the owner, including the address check only they can do. A capture
 * Stripe refuses (the hold lapsed) raises an alert: the domain is theirs and
 * the loss is ours.
 */
export async function captureRegistered(
  env: Env,
  kit: Tenancy,
  orgId: string,
  domainId: string
): Promise<Say | null> {
  const row = await readPurchase(kit, orgId, domainId)
  if (row?.state !== "verifying") return null
  const stripe = DomainStripe.partial().safeParse(row.stripe ?? {}).data
  try {
    if (!stripe?.payment_intent) throw new DomainError("stripe.no_payment")
    await capturePayment(env, stripe.payment_intent, row.id)
  } catch (error) {
    if (transient(error)) throw error
    await alert(kit, orgId, domainId, "domain.capture_failed")
  }
  const registration = await getRegistration(env, row.name)
  const sandbox = !registrarLive(env)
  // The outcome and the details dropped in one update; a sandbox purchase's
  // outcome is `finishSandbox`'s.
  await kit.withOrg({ orgId }, (db) =>
    db
      .update(domains)
      .set({
        registrant: null,
        registration: merged(row, {
          status: "registered",
          auto_renew: registration?.auto_renew ?? true,
          ...(registration?.expires_at && {
            expires_at: registration.expires_at,
          }),
          ...(!sandbox && { outcome: "registered" as const }),
        }),
      })
      .where(eq(domains.id, domainId))
  )
  if (sandbox) return null
  const email = RegistrantDetails.safeParse(row.registrant).data?.registrant
    .email
  return {
    key: `${domainId}:registered`,
    text: `Payment approved and ${row.name} is registered. One thing only you can do: Cloudflare will email ${email ?? "you"} to confirm the address. Please click the link within 15 days, or the domain gets suspended. Your site will be on it in a few minutes.`,
  }
}

/**
 * The yearly renewal Subscription, on the card that paid, first billed 50
 * days before expiry; its id kept on the row. A refusal raises an alert
 * rather than undo a paid registration.
 */
export async function subscribeRenewal(
  env: Env,
  kit: Tenancy,
  orgId: string,
  domainId: string
): Promise<void> {
  const row = await readPurchase(kit, orgId, domainId)
  if (row?.state !== "verifying") return
  const stripe = DomainStripe.partial().safeParse(row.stripe ?? {}).data ?? {}
  const price = DomainPrice.safeParse(row.price).data
  const expiresAt = (row.registration as { expires_at?: unknown } | null)
    ?.expires_at
  try {
    if (stripe.subscription) return
    if (
      !stripe.payment_intent ||
      !stripe.customer ||
      !price ||
      typeof expiresAt !== "string"
    )
      throw new DomainError("stripe.renewal_unready")
    const pi = await getPaymentIntent(env, stripe.payment_intent)
    if (!pi.payment_method) throw new DomainError("stripe.no_payment_method")
    const sub = await createRenewal(env, {
      orgId,
      domainId,
      customer: stripe.customer,
      paymentMethod: pi.payment_method,
      tld: price.tld,
      pence: price.retail_gbp * 100,
      expiresAt,
    })
    await kit.withOrg({ orgId }, (db) =>
      db
        .update(domains)
        .set({ stripe: { ...stripe, subscription: sub.id } })
        .where(eq(domains.id, domainId))
    )
  } catch (error) {
    if (transient(error)) throw error
    await alert(kit, orgId, domainId, "domain.renewal_unset")
  }
}

/**
 * A sandbox purchase ends here: Cloudflare's sandbox never serves a name, so
 * the row is removed (never active, which the router would serve), the name
 * freed, and the owner told it was a test.
 */
export async function finishSandbox(
  env: Env,
  kit: Tenancy,
  orgId: string,
  domainId: string
): Promise<Say | null> {
  const found = await kit.withOrg({ orgId }, async (db) => {
    const claim = await readClaim(db, env, eq(domains.id, domainId))
    if (claim?.row.state !== "verifying") return null
    return (await close(
      db,
      claim.row,
      "removed",
      ["verifying"],
      "test_registered"
    ))
      ? claim
      : null
  })
  if (!found) return null
  return {
    key: `${domainId}:test`,
    text: `That was a test purchase of ${found.row.name}: paid in test mode, registered in Cloudflare's sandbox, and not live on the internet. Your site stays on ${found.slug}.`,
  }
}

/**
 * A live purchase is served: the bought zone, then a Workers Custom Domain
 * for the apex and for `www`, each sending visitors to the router, their ids
 * kept in `cf_ids` so a removal deletes them. Each is a PUT, so a retry
 * repeats it.
 */
export async function serveBought(
  env: Env,
  kit: Tenancy,
  orgId: string,
  domainId: string
): Promise<boolean> {
  const row = await readPurchase(kit, orgId, domainId)
  if (row?.state !== "verifying") return false
  const zoneId = await ensureZone(env, row.name)
  const ids: Record<string, string> = { zone: zoneId }
  for (const [key, hostname] of [
    ["worker_apex", row.name],
    ["worker_www", `www.${row.name}`],
  ] as const) {
    ids[key] = await attachHostname(env, {
      hostname,
      zoneId,
      service: env.ROUTER_SERVICE,
    })
  }
  await kit.withOrg({ orgId }, (db) =>
    db.update(domains).set({ cfIds: ids }).where(eq(domains.id, domainId))
  )
  return true
}

/** Whether the bought domain answers through the router yet. */
export async function boughtReady(
  kit: Tenancy,
  orgId: string,
  domainId: string
): Promise<{ gone: true } | { gone: false; ready: boolean; at: number }> {
  const row = await readPurchase(kit, orgId, domainId)
  if (row?.state !== "verifying") return { gone: true }
  return { gone: false, ready: await reaches(row.name), at: Date.now() }
}

/**
 * Registered and paid but never answering: an alert for us and a message
 * that we are on it. The row stays `verifying`; the domain is the owner's.
 */
export async function servingStalled(
  kit: Tenancy,
  orgId: string,
  domainId: string
): Promise<Say | null> {
  const row = await readPurchase(kit, orgId, domainId)
  if (row?.state !== "verifying") return null
  await alert(kit, orgId, domainId, "domain.serve_failed")
  return {
    key: `${domainId}:stalled`,
    text: `${row.name} is registered to you, but I couldn't put your site on it yet. I've flagged it and will message you when it's live.`,
  }
}
