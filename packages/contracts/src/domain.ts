import { z } from "zod"
import { Timestamp, Uuid } from "./common.ts"
import type { EnvelopeBody } from "./error.ts"
import { E164 } from "./owner.ts"
import { Hostname } from "./site.ts"
import { Text } from "./text.ts"

// Custom domains (ADR-032). An owner's existing domain points at the site
// through records they add at their DNS provider, or the owner buys one and
// pays in Stripe's embedded Checkout. Nothing the CoS reads carries an org id,
// a Cloudflare id or a Stripe secret.

/** A zone apex or a subdomain one level below it: lower-case, punycode for anything not ASCII, at most 253 characters. */
export const DomainName = Hostname

/**
 * Where a domain is. `awaiting_payment` is a purchase waiting on Checkout,
 * and `abandoned` one whose Checkout expired unpaid. `awaiting_dns` waits for
 * the owner's records; `verifying` has seen them, or the payment, and waits
 * on the registration or the certificate.
 */
export const DomainState = z.enum([
  "awaiting_payment",
  "awaiting_dns",
  "verifying",
  "active",
  "failed",
  "abandoned",
  "removed",
])

/** How the domain came to be the org's. */
export const DomainOrigin = z.enum(["connected", "purchased"])

/** How the domain points at Reme. A bought one sits in our account from the start. */
export const ConnectMethod = z.enum(["records", "domain_connect", "purchased"])

/** One record the owner adds, or one that is in the way. */
export const DnsRecord = z.strictObject({
  type: z.enum(["A", "AAAA", "ALIAS", "CAA", "CNAME", "TXT"]),
  name: z.string().min(1).max(253),
  value: z.string().min(1).max(512),
})

/**
 * One check of a domain, in the order dub's verify route decides: the host
 * is unknown to the edge, the check itself failed, a record is in the way,
 * the host is not yet verified, the records point elsewhere, and then the
 * certificate. Only `valid` lets the domain go live.
 */
export const DomainCheck = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("not_found") }),
  z.strictObject({ status: z.literal("unknown_error") }),
  z.strictObject({
    status: z.literal("conflicting_record"),
    conflicts: z.array(DnsRecord).min(1).max(10),
  }),
  z.strictObject({ status: z.literal("pending_verification") }),
  z.strictObject({ status: z.literal("invalid_configuration") }),
  z.strictObject({ status: z.literal("pending_certificate") }),
  z.strictObject({ status: z.literal("valid") }),
])

/**
 * The owner's DNS provider as detected. `settings_url` is only ever one of
 * our own allowlisted links, never a URL a domain's DNS named, and a plain
 * string so a tool output shows the model no `uri` format.
 */
export const DomainProvider = z.strictObject({
  name: Text(80),
  settings_url: z
    .string()
    .max(300)
    .regex(/^https:\/\/[^\s]+$/)
    .optional(),
})

/** The endings Reme sells. */
export const DomainTld = z.enum(["co.uk", "uk", "com"])

/**
 * What the owner pays a year, and the most Cloudflare may charge us for it.
 * The price an owner sees and pays comes from here, never from the model; a
 * live cost over `max_cost_usd` refuses the sale, so a registry price rise
 * never sells at a loss. Live costs 2026-10-16: .co.uk and .uk $5.30, .com
 * $10.46.
 */
export const DOMAIN_PRICES = {
  "co.uk": { retail_gbp: 8, max_cost_usd: 6.5 },
  uk: { retail_gbp: 8, max_cost_usd: 6.5 },
  com: { retail_gbp: 12, max_cost_usd: 12.5 },
} as const satisfies Record<
  z.infer<typeof DomainTld>,
  { retail_gbp: number; max_cost_usd: number }
>

/** Nominet's second levels under `.uk`: endings, never a name to sell. */
const UK_SECOND_LEVELS = new Set([
  "ac",
  "co",
  "gov",
  "ltd",
  "me",
  "mod",
  "net",
  "nhs",
  "org",
  "plc",
  "police",
  "sch",
])

/**
 * The ending of a name Reme can sell: one label then a `DomainTld`, so
 * `sparkle.co.uk` is `co.uk`, and `book.sparkle.co.uk` or `co.uk` is null.
 */
export function sellableTld(name: string): DomainTld | null {
  const [label, ...rest] = name.split(".")
  const tld = DomainTld.safeParse(rest.join(".")).data
  if (!label || !tld) return null
  return tld === "uk" && UK_SECOND_LEVELS.has(label) ? null : tld
}

/** A sale's price as stored on the row: the GBP the owner pays and our live cost. */
export const DomainPrice = z.strictObject({
  tld: DomainTld,
  retail_gbp: z.int().positive(),
  cost_usd: z.number().nonnegative(),
})

/** One name `find_domain` offers: free to register now, at the table's price. */
export const DomainOffer = z.strictObject({
  name: DomainName,
  price_gbp_year: z.int().positive(),
  why: Text(200),
})

/**
 * Who a `.co.uk` or `.uk` is registered to, as Nominet asks: a sole trader,
 * a limited company (with its company number), an LLP, a partnership or an
 * individual. Cloudflare's `GET /registrar/extensions/{ext}` is the live list.
 */
export const RegistrantType = z.enum(["STRA", "LTD", "LLP", "PTNR", "IND"])

/**
 * The domain's registrant, from the business facts and the owner, shaped as
 * Cloudflare's registration contact. It goes to Cloudflare once and Reme
 * never stores it. `state` is the county or region, where there is one.
 */
export const Registrant = z.strictObject({
  name: Text(200).describe("The owner's full legal name, first and last."),
  organization: Text(200)
    .optional()
    .describe("The business's registered or trading name."),
  email: z.email().max(254),
  phone: E164,
  address: z.strictObject({
    street: Text(200),
    city: Text(100),
    state: Text(100).optional(),
    postal_code: Text(20),
    country_code: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .describe("ISO 3166-1 alpha-2, such as GB."),
  }),
})

/** The registrant and, for `.co.uk` and `.uk`, who it is in law. */
export const RegistrantDetails = z.strictObject({
  registrant: Registrant,
  registrant_type: RegistrantType.optional().describe(
    "Required for .co.uk and .uk: STRA sole trader, LTD limited company, LLP, PTNR partnership, IND individual."
  ),
  company_number: z
    .string()
    .regex(/^[A-Z0-9]{8}$/)
    .optional()
    .describe("The Companies House number, required with LTD and LLP."),
})

const StripeId = (prefix: string) =>
  z
    .string()
    .max(255)
    .regex(new RegExp(`^${prefix}_[A-Za-z0-9_]+$`))

/** The Stripe objects behind a purchase, as stored on the row. Ids only, never a secret. */
export const DomainStripe = z.strictObject({
  customer: StripeId("cus"),
  checkout_session: StripeId("cs"),
  payment_intent: StripeId("pi").optional(),
  subscription: StripeId("sub").optional(),
})

/** A bought domain's registration, as stored on the row. */
export const DomainRegistration = z.strictObject({
  years: z.int().min(1).max(10),
  auto_renew: z.boolean(),
  expires_at: Timestamp.nullable(),
  registrant_type: RegistrantType.optional(),
})

/**
 * `POST /domains/{name}/checkout`, web to api: the card's registrant, as
 * shown or as the owner corrected it.
 */
export const DomainCheckoutRequest = RegistrantDetails

/**
 * The api's answer: what the embedded Checkout mounts with. The client
 * secret goes to the browser only, never to the model or a log.
 */
export const DomainCheckout = z.strictObject({
  name: DomainName,
  price_gbp: z.int().positive(),
  client_secret: z.string().min(1).max(500),
  expires_at: Timestamp,
})

const Paid = {
  /** Stripe's event id, so the orchestrator drops a repeat. */
  event_id: StripeId("evt"),
  domain_id: Uuid,
}

/**
 * A verified Stripe webhook as the api hands it to the orchestrator. The api
 * checks the signature on the raw body and reads `domain_id` from the
 * object's metadata; nothing else of Stripe's event crosses.
 */
export const DomainPaymentEvent = z.discriminatedUnion("type", [
  /** The hold is authorised: the PaymentIntent is `requires_capture`. */
  z.strictObject({
    type: z.literal("paid"),
    ...Paid,
    checkout_session: StripeId("cs"),
    payment_intent: StripeId("pi"),
  }),
  /** The Checkout Session expired unpaid. */
  z.strictObject({
    type: z.literal("expired"),
    ...Paid,
    checkout_session: StripeId("cs"),
  }),
  /** `invoice.paid` on the domain's subscription. */
  z.strictObject({
    type: z.literal("renewal_paid"),
    ...Paid,
    subscription: StripeId("sub"),
    invoice: StripeId("in"),
  }),
  /** `invoice.payment_failed` on the domain's subscription. */
  z.strictObject({
    type: z.literal("renewal_failed"),
    ...Paid,
    subscription: StripeId("sub"),
    invoice: StripeId("in"),
  }),
  /** `customer.subscription.deleted`, or the subscription went `unpaid`. */
  z.strictObject({
    type: z.literal("subscription_ended"),
    ...Paid,
    subscription: StripeId("sub"),
  }),
])

/** The buy path's refusals, so the api, the orchestrator and the card say the same thing. */
export const BUY_REFUSALS = {
  unavailable: {
    class: "resource",
    code: "domain.unavailable",
    message: "That name isn't free to register.",
    detail: {},
  },
  registrant_invalid: {
    class: "validation",
    code: "domain.registrant_invalid",
    message: "The registration details aren't complete for that domain.",
    detail: {},
  },
  buy_unavailable: {
    class: "resource",
    code: "domain.buy_unavailable",
    message: "Buying a domain isn't available yet.",
    detail: {},
  },
  price_changed: {
    class: "resource",
    code: "domain.price_changed",
    message: "That domain's price has changed, so nothing was charged.",
    detail: {},
  },
} as const satisfies Record<string, EnvelopeBody>

export type DomainName = z.infer<typeof DomainName>
export type DomainState = z.infer<typeof DomainState>
export type DomainOrigin = z.infer<typeof DomainOrigin>
export type ConnectMethod = z.infer<typeof ConnectMethod>
export type DomainTld = z.infer<typeof DomainTld>
export type DomainPrice = z.infer<typeof DomainPrice>
export type DomainOffer = z.infer<typeof DomainOffer>
export type RegistrantType = z.infer<typeof RegistrantType>
export type Registrant = z.infer<typeof Registrant>
export type RegistrantDetails = z.infer<typeof RegistrantDetails>
export type DomainStripe = z.infer<typeof DomainStripe>
export type DomainRegistration = z.infer<typeof DomainRegistration>
export type DomainCheckoutRequest = z.infer<typeof DomainCheckoutRequest>
export type DomainCheckout = z.infer<typeof DomainCheckout>
export type DomainPaymentEvent = z.infer<typeof DomainPaymentEvent>
export type DnsRecord = z.infer<typeof DnsRecord>
export type DomainCheck = z.infer<typeof DomainCheck>
export type DomainProvider = z.infer<typeof DomainProvider>
