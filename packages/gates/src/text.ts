import type { FactRecord } from "@workspace/contracts"

/**
 * What the content gate reads out of a string, and what it therefore owns.
 * The claims gate reads the same strings for a different kind of lie, so the
 * extractor lives here rather than in either gate: a number the content gate
 * has already traced to a fact is not read again as a marketing claim.
 */

/** The facts a claim may trace to: never an `inferred` one (§10.2). */
export const factsForContent = (facts: readonly FactRecord[]) =>
  facts.filter((f) => f.provenance.source !== "inferred")

export type ContentKind = "email" | "phone" | "price" | "time" | "postcode"
export type ContentClaim = { kind: ContentKind; text: string; key: string }

const CURRENCY: Record<string, string> = {
  $: "USD",
  "£": "GBP",
  "€": "EUR",
  USD: "USD",
  GBP: "GBP",
  EUR: "EUR",
}
const EXTRACT: {
  kind: ContentKind
  pattern: RegExp
  key: (m: RegExpMatchArray) => string | null
}[] = [
  {
    kind: "email",
    pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    key: (m) => m[0].toLowerCase(),
  },
  {
    kind: "price",
    pattern:
      /([$£€])\s?(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s?(USD|GBP|EUR)\b/g,
    key: (m) => {
      const currency = CURRENCY[m[1] ?? m[4] ?? ""]
      const amount = Number((m[2] ?? m[3] ?? "").replace(/,/g, ""))
      return currency && Number.isFinite(amount)
        ? `${currency}:${amount.toFixed(2)}`
        : null
    },
  },
  {
    kind: "phone",
    pattern: /\+?\d[\d\s().-]{6,}\d/g,
    key: (m) => phoneKey(m[0]),
  },
  {
    kind: "time",
    pattern: /\b([01]?\d|2[0-3]):([0-5]\d)\b/g,
    key: (m) => `${(m[1] ?? "").padStart(2, "0")}:${m[2]}`,
  },
  {
    kind: "postcode",
    pattern: /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g,
    key: (m) => m[0].replace(/\s/g, "").toUpperCase(),
  },
]

/**
 * A phone number's digits, with a UK number written as dialled at home
 * ("07700 900123", eleven digits from 0) read as its +44 form, so the page
 * can show the national form of an E.164 fact. Null under seven digits.
 */
export function phoneKey(text: string): string | null {
  const digits = text.replace(/\D/g, "")
  if (digits.length < 7) return null
  return /^0\d{10}$/.test(digits) ? `44${digits.slice(1)}` : digits
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * The text with the site's own host names blanked: each host exactly, in any
 * case, with an optional scheme. Every page names its own host (`og:url`,
 * canonical), and a slug can carry a date. The path, query and fragment after
 * it are still read, as is a host that only contains the site's, or an email
 * on it. No hosts, nothing blanked.
 */
function withoutOwnHosts(text: string, hosts: readonly string[]): string {
  if (!hosts.length) return text
  const own = new RegExp(
    `(?<![a-z0-9.@-])(?:https?://)?(?:${hosts.map(literal).join("|")})(?![a-z0-9-]|\\.[a-z0-9])`,
    "gi"
  )
  return text.replace(own, " ")
}

/**
 * Characters that render blank but are not whitespace to a regular
 * expression; read as spaces so they cannot split a phone or a price.
 */
const BLANKS = /[\u115f\u1160\u200b-\u200d\u2060\u2800\u3164\ufeff\uffa0]/g

/** Every price, phone, email, time and postcode in the text, the site's own hosts aside. */
export function contentClaimsIn(
  text: string,
  hosts: readonly string[] = []
): ContentClaim[] {
  const claims: ContentClaim[] = []
  let rest = withoutOwnHosts(text.replace(BLANKS, " "), hosts)
  for (const { kind, pattern, key } of EXTRACT) {
    for (const m of rest.matchAll(pattern)) {
      const k = key(m)
      if (k) claims.push({ kind, text: m[0], key: k })
    }
    // A matched claim is not read again as another kind (a price's digits are not a phone).
    rest = rest.replace(pattern, " ")
  }
  return claims
}

/**
 * The same text with everything the content gate owns blanked out, so the
 * claims gate never re-reads a price, a time, a phone number, an email or a
 * postcode as a number about the business. It takes no hosts: a long digit
 * run in the site's own URL is blanked here as a phone, and a phone is not
 * something the claims gate reports.
 */
export function maskContentClaims(text: string): string {
  let rest = text
  for (const { pattern } of EXTRACT) rest = rest.replace(pattern, " ")
  return rest
}
