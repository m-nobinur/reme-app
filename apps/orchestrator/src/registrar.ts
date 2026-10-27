/**
 * Buying a domain: the Cloudflare Registrar client, the price table and the
 * name ranker. Registrar calls go to `REGISTRAR_API`, `registrar-sandbox` on
 * local and staging and `registrar` in production only, so tests and staging
 * never reach the live registrar, which charges our card and never refunds.
 * Workers Custom Domains serve a bought domain from the router.
 */
import {
  DOMAIN_PRICES,
  type DomainTld,
  sellableTld,
} from "@workspace/contracts"
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

/**
 * The endings an owner is offered. The sandbox answers `.co.uk` and `.uk`
 * with `extension_not_supported_via_api`, so a purchase there can only finish
 * on `.com`.
 */
export const offeredTlds = (env: RegistrarEnv): readonly DomainTld[] =>
  registrarLive(env) ? ["co.uk", "uk", "com"] : ["com"]

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
    registrant: { business_name?: string }
    registrant_type?: string
    company_number?: string
  }
): string | null {
  if (rules.organizationRequired && !input.registrant.business_name?.trim())
    return "business_name"
  if (rules.registrantTypes.length === 0) return null
  if (
    !input.registrant_type ||
    !rules.registrantTypes.includes(input.registrant_type)
  )
    return "registrant_type"
  const needsNumber = rules.companyNumberFor.includes(input.registrant_type)
  if (needsNumber !== !!input.company_number?.trim()) return "company_number"
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

/** `asked` is a name the owner typed rather than the business name. */
export type RankFacts = {
  name: string
  town?: string
  trade?: string
  asked?: boolean
}
export type Ranked = { stem: string; score: number; why: string }

/** The longest stem with a word added; past it a name is hard to say or type. */
export const ADDED_MAX = 20

const LEGAL = /\b(ltd|limited|llp|plc|inc|co|company|services?|the)\b/g
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, " and ")
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
const label = (s: string) => slug(s).replace(/[^a-z0-9]/g, "")

/** The business name as words, and as the one run of letters its stems build on. */
function brandOf(facts: RankFacts) {
  // "sparklecleaning.com" names the brand: drop the TLD before slugging.
  const words = slug(
    facts.name.trim().replace(/\.[a-z]{2,}(\.[a-z]{2})?$/i, "")
  )
    .replace(LEGAL, " ")
    .split(/\s+/)
    .filter(Boolean)
  return { words, brand: words.join("").replace(/[^a-z0-9]/g, "") }
}

/**
 * The candidate stems for a business, best first: its brand, brand plus town,
 * brand plus trade (when the name does not already say it) and brand-town,
 * each with its own reason. A word the brand already holds is never added
 * again, and a stem with a word added stays within `ADDED_MAX`; the brand
 * alone is kept at any length so a long name still gets a row. A pure
 * function: no model, no network.
 */
export function candidates(facts: RankFacts): Ranked[] {
  const { words, brand } = brandOf(facts)
  if (!brand) return []
  const town = facts.town ? label(facts.town.split(",")[0] ?? "") : ""
  // The trade's last word names it: "Dog grooming" is grooming.
  const trade = facts.trade
    ? label(facts.trade.trim().split(/\s+/).at(-1) ?? "")
    : ""
  // "Sparkle Clean" already says cleaning: a word and the trade share a stem.
  const said =
    !trade ||
    brand.includes(trade) ||
    words.some(
      (w) => w.length >= 4 && (trade.startsWith(w) || w.startsWith(trade))
    )
  const where = facts.town?.split(",")[0]?.trim()
  const yours = facts.asked ? "your words" : "your name"
  const stems: Array<[string, number, string]> = [
    [
      brand,
      40,
      facts.asked ? "exactly what you asked for" : "matches your business name",
    ],
  ]
  if (town && !brand.includes(town)) {
    stems.push([`${brand}${town}`, 25, `${yours} plus ${where}`])
    stems.push([`${brand}-${town}`, 25, `${yours} and ${where}, with a dash`])
  }
  if (!said) stems.push([`${brand}${trade}`, 20, `${yours} plus ${trade}`])
  // A long name gets shorter forms of itself, since a word added to it would
  // pass `ADDED_MAX`: its first and last words, and its first word and town.
  if (words.length >= 3 && brand.length > 15) {
    const first = label(words[0] ?? "")
    const last = label(words.at(-1) ?? "")
    stems.push([`${first}${last}`, 30, `shorter, ${words[0]} ${words.at(-1)}`])
    if (town && first !== town) {
      stems.push([`${first}${town}`, 22, `${words[0]} plus ${where}`])
    }
  }
  // Where and what, without the brand: what people type to find a trade.
  const tradeWords = facts.trade
    ? label(facts.trade.trim().split(/\s+/).slice(-2).join(""))
    : ""
  if (town && tradeWords && !brand.includes(town)) {
    stems.push([`${town}${tradeWords}`, 15, `${where} plus what you do`])
    if (trade && trade !== tradeWords)
      stems.push([`${town}${trade}`, 13, `${where} plus ${trade}`])
  }
  return stems
    .filter(([s], i) => s.length <= (i === 0 ? 63 : ADDED_MAX))
    .map(([stem, points, why]) => ({
      stem,
      why,
      score:
        points -
        Math.max(0, stem.length - 12) -
        (stem.includes("-") ? 10 : 0) -
        (/\d/.test(stem) ? 20 : 0),
    }))
    .sort((a, b) => b.score - a.score)
}

/** Whether `stem` splits wholly into `vocab`'s words, in any order. */
const madeOf = (stem: string, vocab: string[]) => {
  const ends = [true]
  for (let i = 1; i <= stem.length; i++)
    ends[i] = vocab.some(
      (w) => w && ends[i - w.length] && stem.startsWith(w, i - w.length)
    )
  return ends[stem.length] === true
}

/**
 * The registrar's suggested names as stems, to fill the rows the ranker's own
 * leave short. Each is made only of the owner's own words, its name, town and
 * trade, since the registrar also offers fragments ("ndoggrooming"), titles
 * ("drnorthside...") and other trades ("...dogsitting"). The ranker's rules
 * hold: none repeats a word of the name or runs past `ADDED_MAX`, and the
 * reason says how the stem differs from the brand.
 */
export function suggestions(facts: RankFacts, names: string[]): Ranked[] {
  const { words, brand } = brandOf(facts)
  const yours = facts.asked ? "your words" : "your name"
  const vocab = [
    ...words,
    facts.town?.split(",")[0] ?? "",
    ...(facts.trade?.split(/\s+/) ?? []),
  ].map(label)
  return [...new Set(names.map((n) => n.slice(0, n.indexOf("."))))]
    .filter(
      (stem) =>
        stem.length <= ADDED_MAX &&
        madeOf(stem, vocab) &&
        !words.some((w) => w.length >= 3 && stem.split(w).length > 2)
    )
    .map((stem) => ({
      stem,
      score: 10 - Math.max(0, stem.length - 12),
      why:
        brand && stem.startsWith(brand) && stem.length > brand.length
          ? `${yours} plus ${stem.slice(brand.length)}`
          : brand && stem.endsWith(brand) && stem.length > brand.length
            ? `${stem.slice(0, -brand.length)} before ${yours}`
            : `another take on ${yours}`,
    }))
}
