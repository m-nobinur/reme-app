import type { FactRecord } from "@workspace/contracts"
import { CLAIM_VOCABULARY, HIDDEN_FACTS_KEY } from "@workspace/gates"
import { describe, expect, it } from "vitest"
import { siteRules } from "../src/developer-rules.ts"

const hidden = (keys: string[]): FactRecord => ({
  fact_id: "10000001-0000-4000-8000-000000000001",
  org_id: "10000001-0000-4000-8000-000000000000",
  key: HIDDEN_FACTS_KEY,
  fact_type: "site_display",
  value: keys,
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

const text = (revising: boolean, facts: FactRecord[] = []) =>
  siteRules(revising, facts).join("\n")

describe("the Developer's site rules", () => {
  it("lets a change request decide what the site shows and nothing else", () => {
    const rules = text(true)
    expect(rules).toContain("It decides what the site shows")
    expect(rules).toContain("leaving a field empty")
    expect(rules).toContain("never a fact")
    expect(rules).not.toContain("not a rule")
    expect(text(false)).not.toContain("site.change_requested")
  })

  it("never says a required field must be filled", () => {
    expect(text(true)).not.toContain("may not stay empty")
    expect(text(false)).not.toContain("may not stay empty")
  })

  it("asks for every required fact when the owner hid nothing", () => {
    const rules = text(false)
    expect(rules).toContain(
      "The site needs business.name, business.phone, business.email, hours.weekday, service_area.radius, pricing.standard_clean_hourly."
    )
    expect(rules).not.toContain("not appear on the site")
  })

  it("stops asking for a fact the owner left off, and says it is hidden", () => {
    const rules = text(false, [hidden(["pricing.standard_clean_hourly"])])
    expect(rules).toContain(
      "The site needs business.name, business.phone, business.email, hours.weekday, service_area.radius."
    )
    expect(rules).toContain(
      "not appear on the site: pricing.standard_clean_hourly."
    )
  })

  it("sends a requested claim no fact supports to ask_chief", () => {
    expect(text(true)).toContain("call ask_chief for it rather than writing it")
  })

  it("says what persuasive copy is welcome", () => {
    const rules = text(false)
    expect(rules).toContain("benefit-led slogan under eight words")
    expect(rules).toContain("call to action that names the action")
  })

  it("names every word the claims gate fails, from the gate's own list", () => {
    const rules = text(false)
    for (const word of Object.values(CLAIM_VOCABULARY).flat())
      expect(rules, word).toContain(word)
    expect(rules).toContain("Call ask_chief for the fact")
  })

  it("keeps the copy guidance short enough for the cached segment", () => {
    const added = siteRules(false, []).filter((rule) =>
      /Persuasive copy|claims gate fails/.test(rule)
    )
    expect(added).toHaveLength(2)
    expect(added.join(" ").split(/\s+/).length).toBeLessThan(160)
  })
})
