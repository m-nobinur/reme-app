import { type FactRecord, ReviewValue } from "@workspace/contracts"
import { brightclean } from "@workspace/db/fixtures"
import { checkClaims, parsePage } from "@workspace/gates"
import { describe, expect, it } from "vitest"

/**
 * The golden org's reviews as the claims gate reads them on a first build:
 * the fixture rows as a snapshot holds them, with no owner confirming
 * anything first. A local database seeded before `testimonials.quote_1` and
 * `author_1` became `testimonials.review_N` keeps the old rows (the seed
 * never updates a row, and says to `--reset`), and the gate can count none of
 * them: no `permission`, and a lead reading the snapshot sees the old keys.
 */

const snapshot = (): FactRecord[] =>
  brightclean.facts.map((row) => ({
    fact_id: row.id as string,
    org_id: row.orgId as string,
    key: row.key,
    fact_type: row.factType,
    value: row.value,
    version: 1,
    provenance: {
      source: row.provenanceSource as FactRecord["provenance"]["source"],
      confidence: 1,
      verified_by_staff_id: null,
      verified_at: null,
    },
    valid_from: (row.validFrom as Date).toISOString(),
    valid_to: null,
    superseded_by_fact_id: null,
  }))

/** A slot's review as `record_review` stores it; throws if the fixture holds another shape. */
const review = (slot: 1 | 2) =>
  ReviewValue.parse(
    brightclean.facts.find((f) => f.key === `testimonials.review_${slot}`)
      ?.value
  )

const page = ({ quote, name }: { quote: string; name: string }) =>
  parsePage(
    "index.html",
    `<!doctype html><html lang="en"><head><title>BrightClean</title></head><body><main><blockquote><p>“${quote}”</p><cite>${name}</cite></blockquote></main></body></html>`
  )

describe("the golden org's reviews", () => {
  it("are the shape record_review stores, in the slots the site reads", () => {
    expect(
      brightclean.facts
        .filter((f) => f.key.startsWith("testimonials."))
        .map((f) => f.key)
    ).toEqual(["testimonials.review_1", "testimonials.review_2"])
    expect(review(1).permission && review(2).permission).toBe(true)
  })

  it("count on a first build: the claims gate passes a quote they carry", () => {
    for (const slot of [1, 2] as const) {
      expect(checkClaims([page(review(slot))], snapshot())).toMatchObject({
        passed: true,
      })
    }
  })

  it("stop counting once the customer's agreement is gone", () => {
    const unagreed = snapshot().map((f) =>
      f.key === "testimonials.review_1"
        ? { ...f, value: { ...(f.value as object), permission: false } }
        : f
    )
    expect(checkClaims([page(review(1))], unagreed).passed).toBe(false)
  })

  it("give the gate nothing to count in a database seeded before the keys changed", () => {
    const stale = snapshot().flatMap((f) =>
      f.key === "testimonials.review_1"
        ? [{ ...f, key: "testimonials.quote_1", value: { quote: "x" } }]
        : f.key === "testimonials.review_2"
          ? []
          : [f]
    )
    expect(checkClaims([page(review(1))], stale).passed).toBe(false)
  })
})
