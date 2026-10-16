/**
 * Buying a domain: the Cloudflare Registrar client, the price table and the
 * name ranker. Registrar calls go to `REGISTRAR_API`, `registrar-sandbox` on
 * local and staging and `registrar` in production only, so tests and staging
 * never reach the live registrar, which charges our card and never refunds.
 * Workers Custom Domains serve a bought domain from the router.
 */
import { DOMAIN_PRICES, sellableTld } from "@workspace/contracts"
import { CF_API, CF_TIMEOUT_MS, DomainError, resultOf } from "./domains.ts"

export type RegistrarEnv = {
  CF_DOMAINS_TOKEN?: string
  CF_ACCOUNT_ID?: string
  /** `registrar` reaches the live registrar; anything else is the sandbox. */
  REGISTRAR_API?: string
}

/** Whether registrations are real: only then is a bought domain served. */
export const registrarLive = (env: RegistrarEnv) =>
  env.REGISTRAR_API === "registrar"

async function cloudflare(
  env: RegistrarEnv,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  if (!env.CF_DOMAINS_TOKEN || !env.CF_ACCOUNT_ID) {
    throw new DomainError("domains.not_configured")
  }
  return fetch(`${CF_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${env.CF_DOMAINS_TOKEN}`,
      "content-type": "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(CF_TIMEOUT_MS),
  })
}

const registrarPath = (env: RegistrarEnv, path: string) =>
  `/accounts/${env.CF_ACCOUNT_ID}/${registrarLive(env) ? "registrar" : "registrar-sandbox"}${path}`

const registrar = (
  env: RegistrarEnv,
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
  headers?: Record<string, string>
) => cloudflare(env, method, registrarPath(env, path), body, headers)

// ---------------------------------------------------------------------------
// Search and check
// ---------------------------------------------------------------------------

/** One `domain-check` answer, as the API returns it. */
export type Checked = {
  name: string
  registrable: boolean
  tier?: "standard" | "premium"
  reason?: string
  pricing?: {
    currency: string
    registration_cost: string
    renewal_cost: string
  }
}

export const CHECK_MAX = 20

/** Authoritative availability and price for up to 20 names; reserves nothing. */
export async function checkDomains(
  env: RegistrarEnv,
  names: string[]
): Promise<Checked[]> {
  if (names.length === 0) return []
  if (names.length > CHECK_MAX) throw new DomainError("registrar.too_many")
  const result = await resultOf<{ domains: Checked[] }>(
    await registrar(env, "POST", "/domain-check", { domains: names })
  )
  return result.domains
}

/**
 * Names Cloudflare suggests for a query, in the table's TLDs. Not
 * authoritative: every name is checked again before it is offered.
 */
export async function searchDomains(
  env: RegistrarEnv,
  query: string
): Promise<string[]> {
  const q = new URLSearchParams({
    q: query,
    extensions: Object.keys(DOMAIN_PRICES).join(","),
    limit: "10",
  })
  const result = await resultOf<{ domains?: Array<{ name: string }> }>(
    await registrar(env, "GET", `/domain-search?${q}`)
  )
  return (result.domains ?? []).map((d) => d.name).filter((n) => sellableTld(n))
}

/**
 * Whether a check answer may be sold: registrable now, standard tier, in the
 * price table, priced in USD and at or under the TLD's cap. The cost in USD
 * when it may, else null.
 */
export function sellable(checked: Checked): number | null {
  const tld = sellableTld(checked.name)
  if (!tld || !checked.registrable || checked.tier === "premium") return null
  if (checked.pricing?.currency !== "USD") return null
  const cost = Number(checked.pricing.registration_cost)
  const renewal = Number(checked.pricing.renewal_cost)
  const cap = DOMAIN_PRICES[tld].max_cost_usd
  if (!Number.isFinite(cost) || cost > cap || !(renewal <= cap)) return null
  return cost
}

// ---------------------------------------------------------------------------
// Extensions and registrant rules
// ---------------------------------------------------------------------------

/** What an extension's registration schema asks of the registrant. */
export type RegistrantRules = {
  /** `contact_extensions.registrant_type` values, empty when not asked. */
  registrantTypes: string[]
  /** Types that also need `company_number`. */
  companyNumberFor: string[]
  organizationRequired: boolean
}

type Schema = {
  required?: string[]
  properties?: Record<string, Schema>
  oneOf?: Array<{ const?: string }>
  enum?: string[]
  allOf?: Array<{ if?: Schema; then?: Schema }>
}

/**
 * The registrant rules of an extension, read from Cloudflare's own schema
 * (`GET /extensions/{ext}`), so `.co.uk`'s registrant types and company
 * number rule are never copied by hand.
 */
export async function registrantRules(
  env: RegistrarEnv,
  extension: string
): Promise<RegistrantRules> {
  const { registration_schema: schema } = await resultOf<{
    registration_schema: Schema
  }>(
    await registrar(env, "GET", `/extensions/${encodeURIComponent(extension)}`)
  )
  const ext = schema.properties?.contact_extensions
  const type = ext?.properties?.registrant_type
  const postal =
    schema.properties?.contacts?.properties?.registrant?.properties?.postal_info
  return {
    registrantTypes: (type?.oneOf ?? []).flatMap((o) =>
      o.const ? [o.const] : []
    ),
    companyNumberFor: (ext?.allOf ?? []).flatMap((rule) =>
      rule.then?.required?.includes("company_number")
        ? (rule.if?.properties?.registrant_type?.enum ?? [])
        : []
    ),
    organizationRequired: !!postal?.required?.includes("organization"),
  }
}

/** The registrant as Cloudflare takes it: phone in `+44.7…` form. */
export type Registrant = {
  name: string
  organization?: string
  email: string
  phone: string
  address: {
    street: string
    city: string
    state: string
    postal_code: string
    country_code: string
  }
}

/** The owner's details for the extension's rules, or the first rule they break. */
export function registrantProblem(
  rules: RegistrantRules,
  input: {
    registrant: { organization?: string }
    registrant_type?: string
    company_number?: string
  }
): string | null {
  if (rules.organizationRequired && !input.registrant.organization?.trim())
    return "organization"
  if (rules.registrantTypes.length === 0) return null
  if (
    !input.registrant_type ||
    !rules.registrantTypes.includes(input.registrant_type)
  )
    return "registrant_type"
  if (
    rules.companyNumberFor.includes(input.registrant_type) &&
    !input.company_number?.trim()
  )
    return "company_number"
  return null
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** A registration workflow's status, as create and `registration-status` return it. */
export type RegistrationStatus = {
  state:
    | "pending"
    | "in_progress"
    | "action_required"
    | "blocked"
    | "succeeded"
    | "failed"
  completed: boolean
  error?: { code: string; message: string } | null
}

/** A registration as `GET /registrations/{d}` returns it. */
export type Registration = {
  domain_name: string
  status: string
  expires_at: string | null
  auto_renew: boolean
}

/** The registration, or null when this account has none for the name. */
export async function getRegistration(
  env: RegistrarEnv,
  name: string
): Promise<Registration | null> {
  const response = await registrar(
    env,
    "GET",
    `/registrations/${encodeURIComponent(name)}`
  )
  if (response.status === 404) {
    await response.body?.cancel()
    return null
  }
  return resultOf<Registration>(response)
}

/**
 * Starts the registration, one year, auto-renew on, WHOIS redacted, and
 * answers at once (`Prefer: respond-async`); `registrationStatus` follows it.
 * A name this account already holds is a retried step's: its status is read
 * instead, so a retry never asks to register twice.
 */
export async function register(
  env: RegistrarEnv,
  input: {
    name: string
    registrant: Registrant
    registrant_type?: string
    company_number?: string
  }
): Promise<RegistrationStatus> {
  if (await getRegistration(env, input.name))
    return registrationStatus(env, input.name)
  const contactExtensions = input.registrant_type
    ? {
        registrant_type: input.registrant_type,
        ...(input.company_number && { company_number: input.company_number }),
      }
    : undefined
  const { name: holder, organization, address, email, phone } = input.registrant
  return resultOf<RegistrationStatus>(
    await registrar(
      env,
      "POST",
      "/registrations",
      {
        domain_name: input.name,
        years: 1,
        auto_renew: true,
        privacy_mode: "redaction",
        contacts: {
          registrant: {
            email,
            phone,
            postal_info: {
              name: holder,
              ...(organization && { organization }),
              address,
            },
          },
        },
        ...(contactExtensions && { contact_extensions: contactExtensions }),
      },
      { prefer: "respond-async" }
    )
  )
}

export async function registrationStatus(
  env: RegistrarEnv,
  name: string
): Promise<RegistrationStatus> {
  return resultOf<RegistrationStatus>(
    await registrar(
      env,
      "GET",
      `/registrations/${encodeURIComponent(name)}/registration-status`
    )
  )
}

/** Cloudflare's only renewal control: whether it renews on our card. */
export async function setAutoRenew(
  env: RegistrarEnv,
  name: string,
  on: boolean
): Promise<void> {
  await resultOf<unknown>(
    await registrar(
      env,
      "PATCH",
      `/registrations/${encodeURIComponent(name)}`,
      {
        auto_renew: on,
      }
    )
  )
}

// ---------------------------------------------------------------------------
// Serving a bought domain
// ---------------------------------------------------------------------------

/**
 * The bought domain's zone in our account, created if registration did not
 * make one (which it does is UNVERIFIED). Its id.
 */
export async function ensureZone(
  env: RegistrarEnv,
  name: string
): Promise<string> {
  const q = new URLSearchParams({ name, "account.id": env.CF_ACCOUNT_ID ?? "" })
  const [zone] = await resultOf<Array<{ id: string }>>(
    await cloudflare(env, "GET", `/zones?${q}`)
  )
  if (zone) return zone.id
  const made = await resultOf<{ id: string }>(
    await cloudflare(env, "POST", "/zones", {
      name,
      account: { id: env.CF_ACCOUNT_ID },
      type: "full",
    })
  )
  return made.id
}

/**
 * A Workers Custom Domain sending `hostname` to the router, with its DNS
 * record and certificate made by Cloudflare. A PUT, so a retry repeats it.
 * Custom domains, not routes: a router deploy replaces its routes but leaves
 * custom domains it does not list alone. Its id, for the removal.
 */
export async function attachHostname(
  env: RegistrarEnv,
  input: { hostname: string; zoneId: string; service: string }
): Promise<string> {
  const { id } = await resultOf<{ id: string }>(
    await cloudflare(
      env,
      "PUT",
      `/accounts/${env.CF_ACCOUNT_ID}/workers/domains`,
      {
        hostname: input.hostname,
        zone_id: input.zoneId,
        service: input.service,
      }
    )
  )
  return id
}

/** A Workers Custom Domain removed; one already gone is done. */
export async function detachHostname(
  env: RegistrarEnv,
  id: string
): Promise<void> {
  const response = await cloudflare(
    env,
    "DELETE",
    `/accounts/${env.CF_ACCOUNT_ID}/workers/domains/${encodeURIComponent(id)}`
  )
  await response.body?.cancel()
  if (!response.ok && response.status !== 404)
    throw new DomainError(`cloudflare.${response.status}`)
}

// ---------------------------------------------------------------------------
// Name ranker
// ---------------------------------------------------------------------------

export type RankFacts = { name: string; town?: string; trade?: string }
export type Ranked = { name: string; score: number; why: string }

const LEGAL = /\b(ltd|limited|llp|plc|inc|co|company|services?|the)\b/g
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, " and ")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
const label = (s: string) => slug(s).replace(/[^a-z0-9]/g, "")

/**
 * The candidate names for a business, best first: its brand, brand plus town,
 * brand plus trade (when the name does not already say it) and brand-town,
 * each in the table's TLDs. At most 12, one `domain-check`. A pure function:
 * no model, no network.
 */
export function candidates(facts: RankFacts): Ranked[] {
  const words = slug(facts.name)
    .replace(LEGAL, " ")
    .split(/\s+/)
    .filter(Boolean)
  const brand = words.join("").replace(/[^a-z0-9]/g, "")
  if (!brand) return []
  const town = facts.town ? label(facts.town.split(",")[0] ?? "") : ""
  const trade = facts.trade ? label(facts.trade.split(/\s+/)[0] ?? "") : ""
  // "Sparkle Clean" already says cleaning: a word and the trade share a stem.
  const said =
    !trade ||
    words.some(
      (w) => w.length >= 4 && (trade.startsWith(w) || w.startsWith(trade))
    )
  const where = facts.town?.split(",")[0]?.trim()
  const labels: Array<[string, number, string]> = [
    [brand, 40, "matches your business name"],
  ]
  if (town) labels.push([`${brand}${town}`, 25, `your name plus ${where}`])
  if (!said) labels.push([`${brand}${trade}`, 20, "your name plus what you do"])
  if (town)
    labels.push([`${brand}-${town}`, 25, "your name and town, easy to read"])
  const fit: Record<string, [number, string]> = {
    "co.uk": [30, ".co.uk tells customers you're UK-based"],
    com: [25, ".com is the one people guess"],
    uk: [20, ".uk is short and UK-based"],
  }
  const seen = new Set<string>()
  const out: Ranked[] = []
  for (const [l, points, why] of labels) {
    if (l.length > 63) continue
    for (const tld of Object.keys(DOMAIN_PRICES)) {
      const name = `${l}.${tld}`
      if (seen.has(name)) continue
      seen.add(name)
      const [tldPoints, tldWhy] = fit[tld] ?? [0, ""]
      const score =
        points +
        tldPoints -
        Math.max(0, l.length - 12) -
        (l.includes("-") ? 10 : 0) -
        (/\d/.test(l) ? 20 : 0)
      out.push({ name, score, why: `${why}; ${tldWhy}` })
    }
  }
  return out.sort((a, b) => b.score - a.score)
}
