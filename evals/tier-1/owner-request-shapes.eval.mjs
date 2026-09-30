import { createHash } from "node:crypto"
import { brightclean } from "@workspace/db/fixtures"
import { HIDDEN_FACTS_KEY, runGates } from "@workspace/gates"

/**
 * Tier 1 (§16.3), offline: the gates decide what an owner's change request is
 * allowed to put on a site, over built HTML rather than a model.
 *
 * Three of the request shapes in the plan are answerable without a live run,
 * because their answer is a gate result and not a model's behaviour:
 *
 * - an invented claim, the shape that must be refused. The claims gate has to
 *   fail it and name the node it sits in (ADR-033).
 * - a hide, with the owner's `site.hidden_facts` record in the same snapshot.
 *   Every gate has to pass a site with no hours anywhere, structured data
 *   included, because `required` is about asking and never about rendering.
 *   A price is refused outright: no fact states one, so none can be traced.
 * - honest marketing copy written from the facts the owner stated. Every gate
 *   has to pass a page carrying the testimonial, the rating, the years, the
 *   client count, the credential and the guarantee.
 *
 * The facts are the golden org's own, so a fact added or reworded in
 * `packages/db/fixtures/golden.ts` is read here rather than copied. The live
 * shapes, which need a deployed build, are `tier-2/request-shapes.eval.mjs`.
 */

const ORG = brightclean.org.id

/** A golden fixture row as the gates read it: the contract's `FactRecord`. */
const record = (row) => ({
  fact_id: row.id,
  org_id: row.orgId,
  key: row.key,
  fact_type: row.factType,
  value: row.value,
  version: row.version ?? 1,
  provenance: {
    source: row.provenanceSource,
    confidence: row.provenanceConfidence,
    verified_by_staff_id: row.verifiedByStaffId ?? null,
    verified_at: row.verifiedAt?.toISOString() ?? null,
  },
  valid_from: row.validFrom.toISOString(),
  valid_to: row.validTo?.toISOString() ?? null,
  superseded_by_fact_id: row.supersededByFactId ?? null,
})

/** What a snapshot holds: the current version of each key, never a closed one. */
const FACTS = brightclean.facts.filter((row) => !row.validTo).map(record)

/** The same snapshot plus the record of the hours the owner left off the site. */
const HIDDEN = [
  ...FACTS,
  record({
    id: `${ORG.slice(0, 24)}000000009900`,
    orgId: ORG,
    key: HIDDEN_FACTS_KEY,
    factType: "site_display",
    value: ["hours.weekday"],
    provenanceSource: "owner_stated",
    provenanceConfidence: 1,
    validFrom: new Date("2026-01-06T09:00:00.000Z"),
  }),
]

const business = {
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  name: "BrightClean",
  telephone: "+15550142",
  email: "hello@brightclean.invalid",
  openingHours: "Mo-Fr 08:00-17:00",
  areaServed: "Fairhaven",
}
const LD = JSON.stringify(business)
const { openingHours: _, ...unhoured } = business
const NO_HOURS = JSON.stringify(unhoured)
const HOURS_LINE = "<p>Weekdays 08:00 to 17:00, within 25 km of Fairhaven.</p>"

const doc = (main, ld) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>BrightClean</title><script type="application/ld+json">${ld}</script></head><body><main>${main}</main><footer><p><a href="/">Home</a></p></footer></body></html>`

/** The copy the new owner facts pay for: a testimonial, a rating, two counts, a credential and a guarantee. */
const MARKETING = [
  "<h1>Cleaning you can plan your week around</h1>",
  "<p>Rated 4.8 by the people whose homes we clean.</p>",
  "<p>12 years in Fairhaven, 400 clients served.</p>",
  "<p>Fully insured and bonded.</p>",
  "<p>Our put-it-right guarantee: tell us within two working days and we clean it again at no charge.</p>",
  '<blockquote><p>"They worked around my hours and the kitchen has never looked so clean."</p><cite>Marta L.</cite></blockquote>',
  HOURS_LINE,
].join("")

/** The shape that has to be refused: a rank and a review count no fact carries. */
const INVENTED =
  "<p>The #1 rated cleaner in Fairhaven, with over 500 five-star reviews.</p>"

/** A price, which no fact states, so the content gate cannot trace it. */
const PRICED = "<p>Standard cleans from $35 an hour.</p>"

async function gates(html, facts) {
  const body = new TextEncoder().encode(html)
  const results = await runGates({
    manifest: {
      revision_id: ORG,
      site_id: ORG,
      org_id: ORG,
      routes: [],
      headers: {},
      files: { "index.html": createHash("sha256").update(body).digest("hex") },
      built_at: "2026-01-06T09:00:00.000Z",
    },
    read: async (file) => (file === "index.html" ? body : null),
    report: {
      checks: [{ check: "astro check", exit_code: 0, output_key: null }],
    },
    facts,
  })
  return new Map(results.map((r) => [r.gate, r]))
}

/** Every gate that did not pass, as one readable string. */
const failures = (results) =>
  [...results.values()]
    .filter((r) => !r.passed)
    .map((r) => `${r.gate}: ${r.message}`)
    .join("; ")

export default async function ownerRequestShapes() {
  // Honest copy, every claim traced to a fact the owner stated.
  const honest = await gates(doc(MARKETING, LD), FACTS)
  if (failures(honest)) {
    throw new Error(`honest marketing copy was refused: ${failures(honest)}`)
  }

  // The hide, with the owner's record in the snapshot. No hours in the copy
  // and none in the structured data, and every gate still passes.
  const hiddenHtml = doc(MARKETING.replace(HOURS_LINE, ""), NO_HOURS)
  if (hiddenHtml.includes("08:00")) {
    throw new Error("the hidden-hours page still carries the hours")
  }
  const hidden = await gates(hiddenHtml, HIDDEN)
  if (failures(hidden)) {
    throw new Error(
      `a site with the hours left off was refused: ${failures(hidden)}`
    )
  }

  // A price, which the owner never states: some gate has to refuse it.
  if (!failures(await gates(doc(MARKETING + PRICED, LD), FACTS))) {
    throw new Error("a price no fact states passed every gate")
  }

  // The invented claim, which must be refused with the node that carries it.
  const invented = await gates(doc(MARKETING + INVENTED, LD), FACTS)
  const claims = invented.get("claims")
  if (claims?.passed !== false) {
    throw new Error("an invented rank and review count passed the claims gate")
  }
  if (!claims.offending_node?.startsWith("index.html html>body>main>")) {
    throw new Error(
      `the claims gate named no node in the page: ${claims.offending_node}`
    )
  }
  const others = new Map(invented)
  others.delete("claims")
  if (failures(others)) {
    throw new Error(
      `the invented claim should fail the claims gate alone: ${failures(others)}`
    )
  }

  console.log(
    `      3 request shapes over ${FACTS.length} facts: honest copy passed 6 gates, ` +
      `the hidden hours passed 6, a price was refused, the invented claim failed at ${claims.offending_node}`
  )
}
