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
    "8:00 AM to 5:00 PM",
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
    { key: "business.proof", value: { text: "Trading since 2009" } },
    "What sets you apart",
    "Trading since 2009",
  ],
  [
    {
      key: "business.disclaimer",
      value: { text: "Regulated by the Law Society" },
    },
    "Regulatory notice",
    "Regulated by the Law Society",
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
    { key: "assistant.avatar", value: { id: "she_1" } },
    "Assistant's look",
    "Wavy copper hair and round glasses",
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
    { key: "site.direction", value: { id: "counsel" } },
    "Website look",
    "counsel",
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
  [
    {
      key: "testimonials.review_1",
      value: { quote: "Always on time.", name: "Marta L.", permission: true },
    },
    "First review",
    '"Always on time." Marta L.',
  ],
  [
    {
      key: "testimonials.review_2",
      value: { quote: "Spotless.", name: "Owen", permission: true },
    },
    "Second review",
    '"Spotless." Owen',
  ],
]

it("shows the owner's own words or colour, not the word custom", () => {
  expect(
    factText("site.palette", { id: "custom", custom: "Navy and gold" })
  ).toBe("Navy and gold")
  expect(factText("site.palette", { id: "custom", brand: "x" })).toBe("x")
})

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
