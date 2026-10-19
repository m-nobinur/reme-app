import type { Blueprint, FactRecord } from "@workspace/contracts"
import type { Page } from "./page.ts"
import { factsForContent, maskContentClaims } from "./text.ts"

/**
 * The claims gate v0 (§8.5, ADR-033). Persuasion may assert nothing
 * checkable, so every checkable thing a composed field writes has to trace to
 * a fact. The content gate owns prices, phones, emails, times and postcodes;
 * this one owns the rest of what marketing copy can invent.
 *
 * The matching rule, in three lines:
 *
 * - A **number** used as a claim passes when the same number appears anywhere
 *   in the value of a non-`inferred` fact. "200 customers" needs a fact whose
 *   value carries 200.
 * - A **superlative, credential or guarantee** word passes when a fact whose
 *   key starts with one of `SUPPORTING_FACT_PREFIXES` carries that word. Both
 *   sides are compared as stems, each word lowercased, stripped to letters and
 *   digits and cut to five characters, so "insured" traces to "insurance" and
 *   "certified" to "certification"; a phrase has to appear as consecutive
 *   stems, so "phone number" does not support "number one".
 * - An **identity** phrase ("family-run", "independent", "local team", "run
 *   by a local", "small team") passes when any non-`inferred` fact carries
 *   the same phrase, whatever its key: who the business is comes from what
 *   the owner said, never from the writer.
 * - An **absolute** word ("fully", "completely", "comprehensive", "full")
 *   directly before a claim word or a coverage word ("insured", "insurance",
 *   "covered") widens it past what a fact usually states: "Insured up to $5
 *   million" does not support "Fully insured". The whole phrase, absolute
 *   included, has to appear as consecutive stems in a supporting fact.
 * - A **testimonial**, meaning quoted text or a blockquote of twenty
 *   characters or more, passes when a `testimonials.` fact carries that text
 *   and its `permission` is true: the customer agreed to be quoted.
 *
 * Nothing else is inspected, and no rule guesses at intent: a false positive
 * costs the Developer a rewrite or one `ask_chief`, a false negative puts a
 * lie on a tenant's website.
 */

/**
 * What the gate looks for, and what the pack's copy guidance and the evals
 * read so all three say the same thing. `counted` are the nouns that turn a
 * bare number into a claim about the business; the rest are matched as
 * phrases, hyphen and space treated alike ("top-rated" covers "top rated").
 */
export const CLAIM_VOCABULARY = {
  counted: [
    "customers",
    "clients",
    "families",
    "homes",
    "properties",
    "reviews",
    "ratings",
    "stars",
    "years",
    "jobs",
    "cleans",
    "staff",
    "team members",
    "employees",
    "hours",
    "days",
  ],
  superlative: [
    "best",
    "#1",
    "number one",
    "leading",
    "top-rated",
    "most trusted",
    "unbeatable",
    "cheapest",
    "lowest price",
    "lowest prices",
    "fastest",
    "award-winning",
    "better than",
    "cheaper than",
    "trusted by",
    "most reliable",
  ],
  credential: [
    "award",
    "awards",
    "certified",
    "accredited",
    "licensed",
    "insured",
    "bonded",
    "vetted",
    "background-checked",
    "DBS",
    "eco-certified",
    "as seen in",
    "as seen on",
    "member of",
    "partner of",
    "qualified",
    "trained",
    "registered with",
  ],
  // Who the business is: true only when a fact says so. Phrases, not bare "local".
  identity: [
    "family-run",
    "family-owned",
    "family business",
    "independent",
    "independently owned",
    "owner-run",
    "owner-operated",
    "locally owned",
    "locally run",
    "locally based",
    "local team",
    "local business",
    "local company",
    "local family",
    "run by a local",
    "small team",
    "one-person",
    "one-man",
    "one-woman",
    "two-person",
  ],
  guarantee: [
    "guarantee",
    "guarantees",
    "guaranteed",
    "money-back",
    "risk-free",
    "no-quibble",
    "no-obligation",
    "free quote",
    "free quotes",
    "free estimate",
    "satisfaction promise",
    "24/7",
    "round the clock",
    "around the clock",
  ],
} as const

/** Words that widen a claim or a coverage word they sit before. */
const ABSOLUTE_WORDS = [
  "fully",
  "completely",
  "totally",
  "entirely",
  "comprehensively",
  "comprehensive",
  "full",
  "complete",
  "unlimited",
]

/** Coverage words: a claim only when an absolute word widens them. */
const COVERAGE_WORDS = ["insurance", "coverage", "covered", "cover"]

/**
 * The fact keys whose value may carry a superlative, a credential or a
 * guarantee. A site field that renders one of these has to name a fact under
 * one of these prefixes, or the gate refuses it.
 */
export const SUPPORTING_FACT_PREFIXES = [
  "about.",
  "awards.",
  "credentials.",
  "differentiators.",
  "guarantees.",
  "reviews.",
  "testimonials.",
] as const

/**
 * Whole keys that support the same words: the owner's own account of what
 * sets the business apart, which may name its insurance, awards or years.
 */
const SUPPORTING_FACT_KEYS = ["business.proof", "business.disclaimer"] as const

const TESTIMONIAL_PREFIX = "testimonials."

export type ClaimKind =
  | "number"
  | "superlative"
  | "credential"
  | "guarantee"
  | "identity"
  | "testimonial"
  | "generated_image"

export type ClaimFinding = {
  file: string
  node: string
  kind: ClaimKind
  claim: string
}

type Found =
  | { kind: "number"; text: string; value: number }
  | { kind: Exclude<ClaimKind, "number" | "testimonial">; text: string }
  | { kind: "testimonial"; text: string }

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** A word cut to what a stem comparison needs: letters and digits, five of them. */
const stem = (word: string) => word.slice(0, 5)
const stems = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(stem)

const holds = (haystack: string[], needle: string[]) =>
  needle.length > 0 &&
  haystack.some((_, i) => needle.every((w, j) => haystack[i + j] === w))

/** Letters, digits and single spaces: what a testimonial is compared as. */
const flatten = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()

const NUMBER = String.raw`\d[\d,]*(?:\.\d+)?`
const NOUNS = CLAIM_VOCABULARY.counted
  .map((noun) => `${literal(noun).replace(/s$/, "s?")}`)
  .join("|")

/** Where a number stops being a quantity and starts being a claim. */
const NUMBER_CLAIMS: {
  pattern: RegExp
  value?: (m: RegExpMatchArray) => number
}[] = [
  // "200+ customers", "over 20 years", "3 team members". Up to two words may
  // sit between the number and its noun ("200 happy customers").
  {
    pattern: new RegExp(
      `\\b(${NUMBER})\\s*\\+?\\s*(?:[a-z]+\\s+){0,2}(?:${NOUNS})\\b`,
      "gi"
    ),
  },
  // "4.9/5", "4.9 out of 5", "rated 4.9".
  { pattern: /\b(\d(?:\.\d)?)\s*(?:\/\s*5\b|out of 5\b)/gi },
  { pattern: /\brated\s+(\d(?:\.\d)?)\b/gi },
  { pattern: /\b(?:five|5)[-\s]stars?\b/gi, value: () => 5 },
  // "100%", "100 per cent".
  { pattern: new RegExp(`\\b(${NUMBER})\\s*(?:%|per ?cent\\b)`, "gi") },
  // "since 2005", "established 1998", "founded in 2010".
  {
    pattern: /\b(?:since|established|est\.|founded(?:\s+in)?)\s+(\d{4})\b/gi,
  },
  // A bare "200+", which is a count whatever follows it.
  { pattern: new RegExp(`\\b(${NUMBER})\\+`, "g") },
]

/** The three word lists, as one matcher each, longest phrases first. */
const PHRASE_CLAIMS = (
  ["superlative", "credential", "guarantee", "identity"] as const
).flatMap((kind) =>
  [...CLAIM_VOCABULARY[kind]]
    .sort((a, b) => b.length - a.length)
    .map((phrase) => ({
      kind,
      phrase,
      pattern: new RegExp(
        `(?<![a-z0-9])${literal(phrase).replace(/[\s-]+/g, "[\\s-]+")}(?![a-z0-9])`,
        "gi"
      ),
    }))
)

/** "fully insured", "comprehensive coverage", "completely guaranteed": an absolute word and the word it widens. */
const ABSOLUTE_CLAIMS = (() => {
  const words = [
    ...CLAIM_VOCABULARY.superlative,
    ...CLAIM_VOCABULARY.credential,
    ...CLAIM_VOCABULARY.guarantee,
    ...COVERAGE_WORDS,
  ]
    .sort((a, b) => b.length - a.length)
    .map((phrase) => literal(phrase).replace(/[\s-]+/g, "[\\s-]+"))
  const absolute = ABSOLUTE_WORDS.join("|")
  return new RegExp(
    `(?<![a-z0-9])(?:${absolute})[\\s-]+(?:${words.join("|")})(?![a-z0-9])`,
    "gi"
  )
})()

const QUOTED = /["“]([^"“”]{20,})["”]/g

/** Everything in one string that asserts something checkable. */
function claimsIn(text: string): Found[] {
  const masked = maskContentClaims(text)
  const found: Found[] = []
  for (const { pattern, value } of NUMBER_CLAIMS) {
    for (const m of masked.matchAll(pattern)) {
      const n = value ? value(m) : Number((m[1] ?? "").replace(/,/g, ""))
      if (Number.isFinite(n))
        found.push({ kind: "number", text: m[0].trim(), value: n })
    }
  }
  for (const { kind, pattern } of PHRASE_CLAIMS) {
    for (const m of masked.matchAll(pattern))
      found.push({ kind, text: m[0].trim() })
  }
  for (const m of masked.matchAll(ABSOLUTE_CLAIMS))
    found.push({ kind: "credential", text: m[0].trim() })
  for (const m of text.matchAll(QUOTED))
    found.push({ kind: "testimonial", text: m[1] ?? "" })
  // Two rules reading one phrase is one claim, not two.
  const seen = new Set<string>()
  return found.filter((f) => {
    const key = `${f.kind}:${f.text.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

type Support = {
  numbers: Set<number>
  words: string[][]
  /** Every fact's words: an identity phrase passes when any fact says it. */
  anyWords: string[][]
  testimonials: string[]
}

function supportFrom(facts: readonly FactRecord[]): Support {
  const support: Support = {
    numbers: new Set(),
    words: [],
    anyWords: [],
    testimonials: [],
  }
  for (const fact of factsForContent(facts)) {
    // A review the customer never agreed to have quoted supports nothing.
    if (
      fact.key.startsWith(TESTIMONIAL_PREFIX) &&
      (fact.value as { permission?: unknown } | null)?.permission !== true
    )
      continue
    // biome-ignore lint/suspicious/noUnnecessaryConditions: JSON.stringify returns undefined for an undefined value
    const text = JSON.stringify(fact.value) ?? ""
    for (const m of text.matchAll(/\d+(?:\.\d+)?/g))
      support.numbers.add(Number(m[0]))
    support.anyWords.push(stems(text))
    if (
      SUPPORTING_FACT_PREFIXES.some((p) => fact.key.startsWith(p)) ||
      (SUPPORTING_FACT_KEYS as readonly string[]).includes(fact.key)
    )
      support.words.push(stems(text))
    if (fact.key.startsWith(TESTIMONIAL_PREFIX))
      support.testimonials.push(flatten(text))
  }
  return support
}

function isSupported(found: Found, support: Support): boolean {
  if (found.kind === "number") return support.numbers.has(found.value)
  if (found.kind === "testimonial") {
    const quote = flatten(found.text)
    return support.testimonials.some((t) => t.includes(quote))
  }
  const phrase = stems(found.text)
  if (found.kind === "identity")
    return support.anyWords.some((fact) => holds(fact, phrase))
  return support.words.some((fact) => holds(fact, phrase))
}

/** JSON-LD keys whose value is a rating or a count, whatever type it arrives as. */
const RATING_KEYS = new Set([
  "ratingValue",
  "reviewCount",
  "ratingCount",
  "bestRating",
])
/** JSON-LD keys whose value is a credential or a testimonial in its own right. */
const AWARD_KEYS = new Set(["award", "awards"])
const REVIEW_KEYS = new Set(["reviewBody"])

function locatedClaims(page: Page): (Found & { node: string })[] {
  const found: (Found & { node: string })[] = []
  const add = (value: string, node: string) =>
    found.push(...claimsIn(value).map((c) => ({ ...c, node })))
  for (const t of page.texts) {
    add(t.value, t.node)
    // A quoted line is a testimonial; so is a blockquote that never quoted.
    if (t.node.includes("blockquote") && t.value.trim().length >= 20)
      found.push({ kind: "testimonial", text: t.value, node: t.node })
  }
  for (const block of page.jsonLd) {
    let data: unknown
    try {
      data = JSON.parse(block.value)
    } catch {
      continue
    }
    const visit = (value: unknown, key: string) => {
      if (typeof value === "string" || typeof value === "number") {
        if (RATING_KEYS.has(key)) {
          const n = Number(value)
          if (Number.isFinite(n))
            found.push({
              kind: "number",
              text: `${key} ${value}`,
              value: n,
              node: block.node,
            })
        }
        if (typeof value !== "string") return
        if (AWARD_KEYS.has(key))
          found.push({ kind: "credential", text: "award", node: block.node })
        if (REVIEW_KEYS.has(key) && value.trim().length >= 20)
          found.push({ kind: "testimonial", text: value, node: block.node })
        add(value, block.node)
        return
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item, key)
        return
      }
      if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) visit(v, k)
      }
    }
    visit(data, "")
  }
  return found
}

/** Every marketing claim on the built site that no fact supports, with its node. */
export function claimFindings(
  pages: readonly Page[],
  facts: readonly FactRecord[]
): ClaimFinding[] {
  const support = supportFrom(facts)
  return pages.flatMap((page) =>
    locatedClaims(page)
      .filter((c) => !isSupported(c, support))
      .map((c) => ({
        file: page.file,
        node: c.node,
        kind: c.kind,
        claim: c.text,
      }))
  )
}

/**
 * Where a photo is a claim about the business (ADR-039): who works there,
 * what it owns, what it has done, what customers said. A generated image in
 * one of these is a picture of something that may not exist.
 */
export const CLAIM_IMAGE_SECTIONS = [
  "about",
  "gallery",
  "testimonials",
] as const

/** Every generated slot whose section is a claim, with the slot as its node. */
export function generatedImageFindings(
  plan: Pick<Blueprint, "images" | "pages">
): ClaimFinding[] {
  return plan.images.flatMap((slot) => {
    if (slot.source !== "generated") return []
    const section = plan.pages
      .find((p) => p.page === slot.page)
      ?.sections.find((s) => s.kind === slot.section)
    const claim =
      (CLAIM_IMAGE_SECTIONS as readonly string[]).includes(slot.section) ||
      (section?.kind === "service_cards" && section.variant === "fleet")
    return claim
      ? [
          {
            file: `blueprint ${slot.page}`,
            node: `images.${slot.id}`,
            kind: "generated_image" as const,
            claim: slot.subject,
          },
        ]
      : []
  })
}
