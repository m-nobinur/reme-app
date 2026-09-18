import type { FactRecord, SiteFields } from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import { factsToAsk, HIDDEN_FACTS_KEY } from "../src/index.ts"

const FIELDS: SiteFields = {
  name: { kind: "fact", fact_key: "business.name", required: true },
  tagline: { kind: "composed" },
  hours: { kind: "fact", fact_key: "hours.weekday", required: true },
  openingHours: { kind: "fact", fact_key: "hours.weekday", required: true },
  price: {
    kind: "fact",
    fact_key: "pricing.standard_clean_hourly",
    required: true,
  },
  fax: { kind: "fact", fact_key: "business.fax", required: false },
}

const hidden = (value: unknown): FactRecord => ({
  fact_id: "10000001-0000-4000-8000-000000000001",
  org_id: "10000001-0000-4000-8000-000000000000",
  key: HIDDEN_FACTS_KEY,
  fact_type: "site_display",
  value,
  version: 1,
  provenance: {
    source: "owner_stated",
    confidence: 1,
    verified_by_staff_id: null,
    verified_at: null,
  },
  valid_from: "2026-09-18T12:00:00.000Z",
  valid_to: null,
  superseded_by_fact_id: null,
})

describe("factsToAsk", () => {
  it("asks for each required fact once, in declaration order", () => {
    expect(factsToAsk(FIELDS, [])).toEqual({
      ask: ["business.name", "hours.weekday", "pricing.standard_clean_hourly"],
      hidden: [],
    })
  })

  it("does not ask for a fact the owner left off the site", () => {
    expect(
      factsToAsk(FIELDS, [hidden(["pricing.standard_clean_hourly"])])
    ).toEqual({
      ask: ["business.name", "hours.weekday"],
      hidden: ["pricing.standard_clean_hourly"],
    })
  })

  it("reads a record that is not a list of strings as nothing hidden", () => {
    expect(factsToAsk(FIELDS, [hidden({ price: true })]).hidden).toEqual([])
    expect(factsToAsk(FIELDS, [hidden(["hours.weekday", 7])]).hidden).toEqual([
      "hours.weekday",
    ])
  })
})
