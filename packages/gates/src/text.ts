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
  kind?: ContentKind
  pattern: RegExp
  key: (m: RegExpMatchArray) => string | null
}[] = [
  {
    kind: "email",
    pattern: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
    key: (m) => m[0].toLowerCase(),
  },
  // A host name, bare or in a URL, is blanked and read as nothing: the site's
  // own host carries the org slug, which can carry a date. Every label starts
  // with a lowercase letter, so a phone that runs into one ("0900123.x.co.uk")
  // is still read as a phone.
  {
    pattern: /\b[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\b/g,
    key: () => null,
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
    key: (m) => {
      const digits = m[0].replace(/\D/g, "")
      return digits.length >= 7 ? digits : null
    },
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

export function contentClaimsIn(text: string): ContentClaim[] {
  const claims: ContentClaim[] = []
  let rest = text
  for (const { kind, pattern, key } of EXTRACT) {
    for (const m of rest.matchAll(pattern)) {
      const k = key(m)
      if (k && kind) claims.push({ kind, text: m[0], key: k })
    }
    // A matched claim is not read again as another kind (a price's digits are not a phone).
    rest = rest.replace(pattern, " ")
  }
  return claims
}

/**
 * The same text with everything the content gate owns blanked out, so the
 * claims gate never re-reads a price, a time, a phone number, an email or a
 * postcode as a number about the business.
 */
export function maskContentClaims(text: string): string {
  let rest = text
  for (const { pattern } of EXTRACT) rest = rest.replace(pattern, " ")
  return rest
}
