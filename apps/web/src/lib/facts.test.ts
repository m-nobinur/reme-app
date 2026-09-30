import { FactValue } from "@workspace/contracts"
import { factLabel, factText } from "@workspace/ui/lib/facts"
import { expect, it } from "vitest"

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
      key: "business.tagline",
      value: { tagline: "Clean homes, fictional town" },
    },
    "Tagline",
    "Clean homes, fictional town",
  ],
  [
    {
      key: "business.industry",
      value: { name: "Limousine and chauffeur hire", category: "chauffeur" },
    },
    "Industry",
    "Limousine and chauffeur hire",
  ],
  [
    {
      key: "business.offerings",
      value: { items: ["Airport transfers", "Wedding hire"] },
    },
    "Products and services",
    "Airport transfers, Wedding hire",
  ],
  [
    {
      key: "business.audience",
      value: { text: "Couples and corporate travellers" },
    },
    "Who you serve",
    "Couples and corporate travellers",
  ],
  [
    { key: "business.overview", value: { text: "Six cars, booked by phone" } },
    "How you work",
    "Six cars, booked by phone",
  ],
  [
    { key: "service_area.text", value: { text: "Greater Fairhaven" } },
    "Area you cover",
    "Greater Fairhaven",
  ],
  [
    { key: "assistant.name", value: { name: "Sam" } },
    "Assistant's name",
    "Sam",
  ],
  [
    { key: "assistant.pronouns", value: { id: "she_her" } },
    "Assistant's pronouns",
    "she_her",
  ],
  [
    { key: "assistant.tone", value: { id: "friendly" } },
    "Assistant's tone",
    "friendly",
  ],
  [
    { key: "owner.preferred_name", value: { name: "Jo" } },
    "What the assistant calls you",
    "Jo",
  ],
  [
    { key: "site.build_mode", value: { mode: "assistant" } },
    "Who builds the site",
    "assistant",
  ],
  [
    { key: "site.template", value: { id: "classic" } },
    "Website template",
    "classic",
  ],
  [{ key: "site.palette", value: { id: "ocean" } }, "Website colours", "ocean"],
  [
    { key: "site.font", value: { id: "clean_sans" } },
    "Website font",
    "clean_sans",
  ],
  [
    { key: "site.pages", value: { ids: ["home", "quote"] } },
    "Website pages",
    "home, quote",
  ],
  [
    {
      key: "media.uploads",
      value: {
        items: [
          {
            id: "8d9e0f10-2131-4a2b-9c3d-4e5f60718293",
            name: "fleet-front.jpg",
            content_type: "image/jpeg",
            bytes: 1200,
          },
        ],
      },
    },
    "Your photos",
    "fleet-front.jpg",
  ],
  [
    {
      key: "quote.form",
      value: {
        fields: [
          {
            key: "pickup",
            label: "Pick-up address",
            type: "text",
            required: true,
            hint: null,
            options: null,
          },
          {
            key: "passengers",
            label: "Passengers",
            type: "number",
            required: true,
            hint: null,
            options: null,
          },
        ],
      },
    },
    "Quote request questions",
    "Pick-up address, Passengers",
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
