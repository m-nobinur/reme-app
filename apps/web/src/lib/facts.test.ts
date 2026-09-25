import { FactValue } from "@workspace/contracts"
import { expect, it } from "vitest"
import { factLabel, factText } from "./facts"

/**
 * Every value an owner can state, as the profile shows it. One sample per
 * `FactValue` branch, checked against the contract first so a sample cannot
 * drift into a shape the owner could never have stated.
 */
const SHAPES: [FactValue, string, string][] = [
  [
    { key: "business.name", value: { name: "Fictional Co" } },
    "Business name",
    "Fictional Co",
  ],
  [
    { key: "business.phone", value: { e164: "+447700900123" } },
    "Phone number",
    "+447700900123",
  ],
  [
    { key: "business.email", value: { address: "hello@example.invalid" } },
    "Email address",
    "hello@example.invalid",
  ],
  [
    { key: "hours.weekday", value: { open: "08:00", close: "17:00" } },
    "Weekday hours",
    "08:00 to 17:00",
  ],
  [
    {
      key: "service_area.radius",
      value: { centre: "Fairhaven", radius_km: 25 },
    },
    "Service area",
    "Fairhaven, within 25 km",
  ],
  [
    {
      key: "pricing.standard_clean_hourly",
      value: { amount_minor: 3500, currency: "GBP" },
    },
    "Hourly price for a standard clean",
    "£35.00 an hour",
  ],
  [
    {
      key: "business.tagline",
      value: { tagline: "Clean homes, fictional town" },
    },
    "Tagline",
    "Clean homes, fictional town",
  ],
]

it("has a sample for every FactValue branch", () => {
  expect(SHAPES.map(([fact]) => fact.key)).toEqual(
    FactValue.options.map((option) => option.shape.key.value)
  )
})

for (const [fact, label, text] of SHAPES) {
  it(`shows ${fact.key} in the owner's words`, () => {
    FactValue.parse(fact)
    expect(factLabel(fact.key)).toBe(label)
    expect(factText(fact.key, fact.value)).toBe(text)
  })
}

it("names a key it has no label for by its last segment", () => {
  expect(factLabel("hours.saturday_close")).toBe("Saturday close")
})

it("shows a shape it does not recognise as it is rather than inventing a sentence", () => {
  expect(factText("policies.pets", { allowed: true })).toBe('{"allowed":true}')
})
