import type { FactRecord } from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import {
  CLAIM_VOCABULARY,
  checkClaims,
  parsePage,
  SUPPORTING_FACT_PREFIXES,
} from "../src/index.ts"

const ORG = "10000001-0000-4000-8000-000000000000"
const AT = "2026-09-18T12:00:00.000Z"
let n = 0
const fact = (
  key: string,
  value: unknown,
  source: FactRecord["provenance"]["source"] = "owner_stated"
): FactRecord => ({
  fact_id: `10000001-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  org_id: ORG,
  key,
  fact_type: key.split(".")[0] ?? "x",
  value,
  version: 1,
  provenance: {
    source,
    confidence: 1,
    verified_by_staff_id: null,
    verified_at: null,
  },
  valid_from: AT,
  valid_to: null,
  superseded_by_fact_id: null,
})

/** The facts every site holds: a business, its hours, its area and its price. */
const PLAIN = [
  fact("business.name", { name: "BrightClean" }),
  fact("business.phone", { e164: "+15550142" }),
  fact("hours.weekday", { open: "08:00", close: "17:00" }),
  fact("service_area.radius", { centre: "Fairhaven", radius_km: 25 }),
  fact("pricing.standard_clean_hourly", {
    currency: "USD",
    amount_minor: 3500,
  }),
]

/** The facts an owner has to hold before persuasive copy may say any of this. */
const MARKETING = [
  ...PLAIN,
  fact("reviews.summary", { rating: 4.9, out_of: 5, count: 200 }),
  fact("about.founded", { year: 2005, years_trading: 20 }),
  fact("credentials.insurance", { statement: "Fully insured and bonded" }),
  fact("guarantees.satisfaction", { statement: "100% satisfaction guarantee" }),
  fact("awards.local", { name: "Award-winning cleaner of the year" }),
  fact("differentiators.value", { statement: "Best value in Fairhaven" }),
  fact("testimonials.jane", {
    quote: "They left the kitchen spotless and were on time",
    author: "Jane R",
  }),
]

const page = (main: string, ld = "") =>
  parsePage(
    "index.html",
    `<!doctype html><html lang="en"><head><title>BrightClean</title>${
      ld ? `<script type="application/ld+json">${ld}</script>` : ""
    }</head><body><main>${main}</main><footer><p>© 2026 BrightClean</p></footer></body></html>`
  )

const verdict = (main: string, facts: readonly FactRecord[], ld?: string) =>
  checkClaims([page(main, ld)], facts)

describe("the claims gate", () => {
  it("reads a claim that runs into the next word without a space", () => {
    for (const [main, facts, claim] of [
      ["<p>We are the best.call now</p>", PLAIN, "best"],
      ["<p>500 customers.join them</p>", MARKETING, "500 customers"],
    ] as const) {
      expect(verdict(main, facts).message, main).toContain(`"${claim}"`)
    }
  })

  it("passes a number a fact carries and fails the same number invented", () => {
    for (const main of [
      "<p>Rated 4.9 by 200+ customers</p>",
      "<p>4.9/5 from 200 reviews</p>",
      "<p>20 years of experience, serving Fairhaven since 2005</p>",
      "<p>100% satisfaction</p>",
      "<p>A five-star clean</p>",
    ]) {
      expect(verdict(main, MARKETING).passed, main).toBe(true)
    }
    for (const main of [
      "<p>Rated 4.7 by 500+ customers</p>",
      "<p>30 years of experience</p>",
      "<p>Serving Fairhaven since 1998</p>",
      "<p>Trusted by 500 families</p>",
    ]) {
      const result = verdict(main, MARKETING)
      expect(result.passed, main).toBe(false)
      expect(result.offending_node, main).toMatch(
        /^index\.html html>body>main>p/
      )
    }
  })

  it("passes a superlative a fact states and fails one it does not", () => {
    expect(verdict("<p>Best value in Fairhaven</p>", MARKETING).passed).toBe(
      true
    )
    expect(verdict("<p>Award-winning cleaners</p>", MARKETING).passed).toBe(
      true
    )
    for (const main of [
      "<p>The #1 cleaner in Fairhaven</p>",
      "<p>The leading cleaning company</p>",
      "<p>Cheaper than every other cleaner</p>",
      "<p>Unbeatable, top-rated and most trusted</p>",
    ]) {
      const result = verdict(main, PLAIN)
      expect(result.passed, main).toBe(false)
      expect(result.offending_node, main).toContain("index.html html>body>main")
    }
  })

  it("lets the owner's business.proof support what it says, and nothing more", () => {
    const proof = [
      ...PLAIN,
      fact("business.proof", {
        text: "Fully insured, and every job guaranteed",
      }),
    ]
    for (const main of ["<p>Fully insured</p>", "<p>Guaranteed work</p>"])
      expect(verdict(main, proof).passed, main).toBe(true)
    expect(verdict("<p>Award-winning cleaners</p>", proof).passed).toBe(false)
  })

  it("passes a credential or guarantee a fact states and fails one it does not", () => {
    for (const main of [
      "<p>Fully insured and bonded</p>",
      "<p>Our satisfaction guarantee</p>",
    ]) {
      expect(verdict(main, MARKETING).passed, main).toBe(true)
    }
    for (const main of [
      "<p>Every cleaner is DBS certified</p>",
      "<p>Accredited and licensed</p>",
      "<p>Money-back guarantee</p>",
      "<p>As seen in the local press</p>",
    ]) {
      const result = verdict(main, PLAIN)
      expect(result.passed, main).toBe(false)
      expect(result.message, main).toContain("index.html")
    }
  })

  it("passes a testimonial a fact carries and fails a quote it does not", () => {
    const real =
      '<blockquote><p>"They left the kitchen spotless and were on time"</p><cite>Jane R</cite></blockquote>'
    expect(verdict(real, MARKETING).passed).toBe(true)
    const invented =
      '<blockquote><p>"The best clean my house has ever had"</p><cite>Sam T</cite></blockquote>'
    const result = verdict(invented, MARKETING)
    expect(result.passed).toBe(false)
    expect(result.offending_node).toContain("blockquote")
  })

  it("reads a rating, a review count and an award out of structured data", () => {
    const ld = JSON.stringify({
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      name: "BrightClean",
      award: "Cleaner of the year",
      aggregateRating: { ratingValue: 4.9, reviewCount: 200 },
    })
    expect(verdict("<p>Cleaning in Fairhaven</p>", MARKETING, ld).passed).toBe(
      true
    )
    const invented = ld.replace('"ratingValue":4.9', '"ratingValue":4.5')
    const result = verdict("<p>Cleaning in Fairhaven</p>", MARKETING, invented)
    expect(result.passed).toBe(false)
    expect(result.offending_node).toContain("script")
  })

  it("never lets an inferred fact support a claim", () => {
    const facts = [
      ...PLAIN,
      fact("reviews.summary", { count: 500 }, "inferred"),
    ]
    expect(verdict("<p>500 happy customers</p>", facts).passed).toBe(false)
  })

  it("leaves honest copy alone", () => {
    for (const main of [
      "<p>We take care over every clean</p>",
      "<p>Book a clean today</p>",
      "<h1>Friendly, reliable cleaning in Fairhaven</h1>",
      "<p>Your home, looked after</p>",
      "<p>Get a quote in minutes</p>",
      "<p>Open weekdays 08:00 to 17:00</p>",
      "<ol><li>Step 1: tell us about your home</li><li>Step 2: pick a time</li><li>Step 3: we clean</li></ol>",
      "<p>Within 25 km of Fairhaven</p>",
      "<p>$35 an hour</p>",
    ]) {
      expect(verdict(main, PLAIN).passed, main).toBe(true)
    }
  })

  it("publishes the vocabulary and the fact prefixes that support it", () => {
    const words = Object.values(CLAIM_VOCABULARY).flat()
    for (const word of ["best", "#1", "certified", "insured", "guaranteed"])
      expect(words).toContain(word)
    expect(SUPPORTING_FACT_PREFIXES).toContain("credentials.")
    expect(SUPPORTING_FACT_PREFIXES).toContain("testimonials.")
    for (const prefix of SUPPORTING_FACT_PREFIXES)
      expect(prefix.endsWith(".")).toBe(true)
  })
})
