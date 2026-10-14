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
  fact("testimonials.review_1", {
    quote: "They left the kitchen spotless and were on time",
    name: "Jane R",
    permission: true,
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

  it("holds the About page's rephrased overview and audience to their facts", () => {
    const facts = [
      ...PLAIN,
      fact("business.overview", {
        text: "One cleaner keeps each home, on the same day every week.",
      }),
      fact("business.audience", { text: "Households with busy weeks." }),
    ]
    // overviewBody, then audienceBody, as the About page's story renders them.
    const story = (overviewBody: string, audienceBody: string) =>
      `<section class="band about-story"><h2>One cleaner for every home</h2><p class="section-lede">${overviewBody}</p><h3>Who we clean for</h3><p>${audienceBody}</p></section>`
    const overview =
      "Your home gets one cleaner, who comes on the same day each week."
    const audience = "We clean for households with busy weeks."
    expect(verdict(story(overview, audience), facts).passed).toBe(true)
    for (const claim of [
      "We are an award-winning team.",
      "We have 20 years of experience.",
      "We are fully insured.",
    ]) {
      for (const main of [
        story(`${overview} ${claim}`, audience),
        story(overview, `${audience} ${claim}`),
      ]) {
        const result = verdict(main, facts)
        expect(result.passed, main).toBe(false)
        expect(result.offending_node, main).toContain("section>p")
      }
    }
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

  it("fails a widening word the fact does not hold: 'Fully insured' is broader than a stated limit", () => {
    const limited = [
      ...PLAIN,
      fact("credentials.insurance", { statement: "Insured up to $5 million" }),
    ]
    for (const main of [
      "<p>Fully insured</p>",
      "<p>Completely insured and bonded</p>",
      "<p>Comprehensive insurance</p>",
      "<p>Full coverage on every clean</p>",
      "<p>Fully covered</p>",
      "<p>Totally guaranteed</p>",
    ]) {
      const result = verdict(main, limited)
      expect(result.passed, main).toBe(false)
      expect(result.message, main).toContain("index.html")
    }
    // What the fact says, and its plain claim word, still pass.
    for (const main of ["<p>Insured up to $5 million</p>", "<p>Insured</p>"])
      expect(verdict(main, limited).passed, main).toBe(true)
    // A widening word that sits before nothing the gate watches is copy, not a claim.
    for (const main of [
      "<p>Full-service cleaning</p>",
      "<p>A complete clean, start to finish</p>",
      "<p>We cover Fairhaven fully</p>",
    ])
      expect(verdict(main, limited).passed, main).toBe(true)
    // The fact that holds the widening word supports it.
    const full = [
      ...PLAIN,
      fact("credentials.insurance", { statement: "Fully insured" }),
    ]
    expect(verdict("<p>Fully insured</p>", full).passed).toBe(true)
    expect(verdict("<p>Comprehensive insurance</p>", full).passed).toBe(false)
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

  it("fails a quote whose review the customer never agreed to have shown", () => {
    const real =
      '<blockquote><p>"They left the kitchen spotless and were on time"</p><cite>Jane R</cite></blockquote>'
    const unagreed = MARKETING.map((f) =>
      f.key === "testimonials.review_1"
        ? { ...f, value: { ...(f.value as object), permission: false } }
        : f
    )
    expect(verdict(real, unagreed).passed).toBe(false)
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

describe("generated images in a claim section", () => {
  const slot = (
    id: string,
    section: "hero" | "about" | "gallery" | "service_cards",
    source: "generated" | "upload"
  ) => ({
    id,
    page: "home",
    section,
    aspect: "4:3",
    resolution: "1K",
    subject: "a cleaner holding a bucket",
    alt: "A cleaner at work",
    source,
    asset_id: "20000001-0000-4000-8000-000000000000",
  })
  const sections = [
    { kind: "hero", variant: "wash" },
    { kind: "about", variant: "default" },
    { kind: "gallery", variant: "default" },
    { kind: "service_cards", variant: "fleet" },
  ].map((s) => ({ ...s, purpose: "x", content_notes: null }))
  const plan = (...images: ReturnType<typeof slot>[]) =>
    ({ images, pages: [{ page: "home", sections }] }) as never

  it("fails a generated slot in a claim section and names the slot", () => {
    const r = checkClaims([], PLAIN, plan(slot("team", "about", "generated")))
    expect(r.passed).toBe(false)
    expect(r.offending_node).toContain("images.team")
  })

  it("fails a generated slot in a fleet services section", () => {
    const r = checkClaims(
      [],
      PLAIN,
      plan(slot("cars", "service_cards", "generated"))
    )
    expect(r.passed).toBe(false)
  })

  it("passes a generated hero and an uploaded photo in a claim section", () => {
    const r = checkClaims(
      [],
      PLAIN,
      plan(slot("hero", "hero", "generated"), slot("work", "gallery", "upload"))
    )
    expect(r.passed).toBe(true)
  })
})
