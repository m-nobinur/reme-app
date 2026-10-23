import type {
  Blueprint,
  DesignDirection,
  FactRecord,
} from "@workspace/contracts"
import { SECTION_VARIANTS } from "@workspace/contracts"
import { describe, expect, it, vi } from "vitest"

import { blueprintLayout, blueprintLines } from "../src/blueprint.ts"
import { loadDirections, STAND_IN_DIRECTIONS } from "../src/directions.ts"
import {
  diversityNote,
  fallbackBlueprint,
  outputSchema,
  ownerChoices,
  plan,
  plannerPrompt,
  problems,
  withOwnerChoices,
} from "../src/planner.ts"

// brief.ts names the registry host from sandbox.ts, which loads the container SDK.
vi.mock("../src/sandbox.ts", () => ({
  NPM_REGISTRY_HOST: "registry.npmjs.org",
}))

const fact = (
  key: string,
  value: unknown,
  source: FactRecord["provenance"]["source"] = "owner_stated"
): FactRecord => ({
  fact_id: "10000001-0000-4000-8000-000000000001",
  org_id: "10000001-0000-4000-8000-000000000000",
  key,
  fact_type: key.split(".")[0] as string,
  value,
  version: 1,
  provenance: {
    source,
    confidence: 1,
    verified_by_staff_id: null,
    verified_at: null,
  },
  valid_from: "2026-10-14T12:00:00.000Z",
  valid_to: null,
  superseded_by_fact_id: null,
})

const AFTER_DARK: DesignDirection = {
  id: "after_dark",
  label: "After dark",
  industries: ["chauffeur", "events"],
  fonts: "cormorant_manrope",
  palettes: ["onyx", "midnight"],
  hero: "dark_center",
  services: "fleet",
  steps: "dark_band",
  faq: "stacked",
  cta: "photo",
  radius: "soft",
  bands: "inverted",
  ornament: "wide tracking",
  image_style: "Night and golden-hour vehicle details and reflections.",
  voice: "Unhurried and assured.",
}
const LIBRARY = [...STAND_IN_DIRECTIONS, AFTER_DARK]

/** One fictional business per pack. */
const business = (category: string, name: string) => [
  fact("business.name", { name }),
  fact("business.industry", { name: category, category }),
  fact("business.offerings", { items: ["One thing", "Another"] }),
]
const CLEANING = business("cleaning", "Fairhaven Fresh (fictional)")
const LEGAL = business("legal", "Ashby & Moor Solicitors (fictional)")
const CHAUFFEUR = business("chauffeur", "Northgate Cars (fictional)")

/** A completion that replies with each text in turn, recording the calls. */
function scripted(replies: (string | Error)[]) {
  const calls: { user: string; system: string }[] = []
  const complete = async (call: { user: string; system: string }) => {
    calls.push(call)
    const next = replies.shift() ?? new Error("no reply scripted")
    if (next instanceof Error) throw next
    return { text: next, usage: { cost: { total: 0.01 } }, model: "sonnet" }
  }
  return { calls, complete }
}

const ROUTE = { model: "sonnet", effort: "high" as const, maxTokens: 32_000 }

describe("the directions library", () => {
  it("stands in with two directions until directions.json exists", () => {
    expect(loadDirections(undefined).map((d) => d.id)).toEqual([
      "calm_daylight",
      "counsel",
    ])
  })

  it("reads the file as an array or under `directions`", () => {
    const raw = JSON.stringify([AFTER_DARK])
    expect(loadDirections(raw)).toEqual([AFTER_DARK])
    expect(
      loadDirections(JSON.stringify({ _: "note", directions: [AFTER_DARK] }))
    ).toEqual([AFTER_DARK])
  })

  it("refuses a file a direction in it does not parse", () => {
    expect(() =>
      loadDirections(JSON.stringify([{ ...AFTER_DARK, hero: "nope" }]))
    ).toThrow()
    expect(() => loadDirections("[]")).toThrow()
  })
})

describe("the structured output schema", () => {
  it("keeps no keyword Claude's structured outputs refuse", () => {
    const text = JSON.stringify(outputSchema())
    for (const word of [
      "oneOf",
      "minLength",
      "maxLength",
      "pattern",
      "maxItems",
      "$schema",
    ]) {
      expect(text, word).not.toContain(`"${word}"`)
    }
    expect(text).toContain('"anyOf"')
    expect(text).toContain('"additionalProperties":false')
  })

  it("keeps each dropped id pattern as a description the model reads", () => {
    // biome-ignore lint/suspicious/noExplicitAny: walks a JSON Schema
    const schema = outputSchema().properties as Record<string, any>
    expect(schema.direction.pattern).toBeUndefined()
    expect(schema.direction.description).toMatch(/Must match \^\[a-z\]/)
    // An upload slot and a generated one differ, so the slot stays a union.
    for (const slot of schema.images.items.anyOf) {
      expect(slot.properties.id.description).toMatch(
        /Must match \^\[a-z\]\[a-z0-9_\]/
      )
    }
  })

  // Anthropic refused the per-kind union as "compiled grammar is too large".
  it("sends a section as one object with every kind and variant pooled", () => {
    // biome-ignore lint/suspicious/noExplicitAny: walks a JSON Schema
    const props = outputSchema().properties as Record<string, any>
    const pages = props.pages
    const section = pages.items.properties.sections.items
    expect(section.anyOf).toBeUndefined()
    expect(section.properties.kind.enum).toEqual(Object.keys(SECTION_VARIANTS))
    expect(new Set(section.properties.variant.enum)).toEqual(
      new Set(Object.values(SECTION_VARIANTS).flat())
    )
    expect(section.required).toEqual(
      expect.arrayContaining(["kind", "variant", "purpose", "content_notes"])
    )
    // A union whose branches differ beyond kind stays a union.
    expect(props.palette.anyOf).toHaveLength(2)
  })
})

describe("the fallback Blueprint", () => {
  it.each([
    ["cleaning", CLEANING, "calm_daylight"],
    ["legal", LEGAL, "counsel"],
    ["chauffeur", CHAUFFEUR, "after_dark"],
  ])("plans a %s business from its pack and direction", (_, facts, id) => {
    const made = fallbackBlueprint({ facts, recent: [], library: LIBRARY })
    expect(made.direction).toBe(id)
    expect(problems(made, { facts, library: LIBRARY })).toEqual([])
    expect(made.pages.map((p) => p.page)).toEqual([
      "home",
      "about",
      "services",
      "service",
      "service_area",
      "contact",
      "quote",
    ])
  })

  it("takes the owner's direction and font pair from the design tray", () => {
    const facts = [
      ...CLEANING,
      fact("site.direction", { id: "counsel" }),
      fact("site.font", { id: "sora_manrope" }),
    ]
    const made = fallbackBlueprint({ facts, recent: [], library: LIBRARY })
    expect([made.direction, made.fonts]).toEqual(["counsel", "sora_manrope"])
    // Left to the builder, or the assistant's guess: the plan decides.
    for (const held of [
      fact("site.direction", { id: "builder" }),
      fact("site.direction", { id: "counsel" }, "inferred"),
    ]) {
      expect(ownerChoices([...CLEANING, held]).direction).toBeUndefined()
    }
    expect(
      withOwnerChoices({ ...made, direction: "calm_daylight" }, facts).direction
    ).toBe("counsel")
  })

  it("takes the direction recent sites used least", () => {
    const two = [
      ...LIBRARY,
      { ...STAND_IN_DIRECTIONS[0], id: "bright_local" } as DesignDirection,
    ]
    const recent = [
      { direction: "calm_daylight", hero: "wash", services: "photo_cards" },
    ]
    expect(
      fallbackBlueprint({ facts: CLEANING, recent, library: two }).direction
    ).toBe("bright_local")
  })

  it("keeps the owner's palette, fonts and pages, and uses their photo", () => {
    const facts = [
      ...CLEANING,
      fact("site.palette", { id: "berry" }),
      fact("site.font", { id: "classic_serif" }),
      fact("site.pages", { ids: ["home", "services"] }),
      fact("media.uploads", {
        items: [
          {
            id: "20000000-0000-4000-8000-000000000001",
            name: "kitchen.jpg",
            content_type: "image/jpeg",
            bytes: 1000,
            alt: "A clean kitchen",
          },
        ],
      }),
    ]
    const made = fallbackBlueprint({ facts, recent: [], library: LIBRARY })
    expect(made.palette).toEqual({ kind: "preset", id: "berry" })
    expect(made.fonts).toBe("newsreader_inter")
    expect(made.pages.map((p) => p.page)).toEqual([
      "home",
      "services",
      "service",
      "quote",
    ])
    // The owner's photo is the hero and the gallery; every other slot is drawn.
    expect(made.images.map((s) => [s.id, s.source])).toEqual([
      ["home_hero", "upload"],
      ["service_1_card", "generated"],
      ["service_2_card", "generated"],
      ["gallery_1", "upload"],
      ["service_1_hero", "generated"],
      ["service_2_hero", "generated"],
    ])
    expect(made.images[0]).toMatchObject({ alt: "A clean kitchen" })
    expect(problems(made, { facts, library: LIBRARY })).toEqual([])
  })

  it("places each photo by its use, draws only what they leave, and never uses the logo", () => {
    const photo = (n: number, use: string) => ({
      id: `20000000-0000-4000-8000-00000000000${n}`,
      name: `${use}.jpg`,
      content_type: "image/jpeg",
      bytes: 1000,
      alt: `The ${use}`,
      use,
    })
    const facts = [
      ...CLEANING,
      fact("site.pages", { ids: ["home", "services", "about", "quote"] }),
      fact("media.uploads", {
        items: [
          photo(1, "logo"),
          photo(2, "work"),
          photo(3, "hero"),
          photo(4, "team"),
        ],
      }),
    ]
    const made = fallbackBlueprint({ facts, recent: [], library: LIBRARY })
    const placed = Object.fromEntries(
      made.images.map((s) => [
        s.id,
        s.source === "upload" ? s.asset_id.slice(-1) : "drawn",
      ])
    )
    // The work fills the home page's gallery, so the cards beside it are drawn.
    expect(placed).toMatchObject({
      home_hero: "3",
      gallery_1: "2",
      service_1_card: "drawn",
      service_2_card: "drawn",
      about_hero: "4",
    })
    expect(Object.values(placed)).not.toContain("1")
    expect(problems(made, { facts, library: LIBRARY })).toEqual([])
  })

  it("leaves a palette the assistant picked to the plan", () => {
    const facts = [
      ...CLEANING,
      fact("site.palette", { id: "berry" }, "inferred"),
    ]
    const made = fallbackBlueprint({ facts, recent: [], library: LIBRARY })
    expect(made.palette).toEqual({ kind: "preset", id: "forest" })
  })
})

describe("the photo shot list", () => {
  const slot = (
    id: string,
    section: string,
    aspect: string,
    extra: Record<string, unknown> = {}
  ) => ({
    id,
    page: "home",
    section,
    aspect,
    resolution: "1K",
    subject: "x",
    alt: "x",
    source: "generated",
    ...extra,
  })

  it("draws each generated photo at the shape of its box, whatever the model wrote", () => {
    const made = fallbackBlueprint({
      facts: CLEANING,
      recent: [],
      library: LIBRARY,
    })
    // calm_daylight's wash photo is the right half of the hero, not a 16:9 strip.
    expect(made.images[0]).toMatchObject({ section: "hero", aspect: "4:3" })
    const withHero = (variant: string) =>
      ({
        ...made,
        pages: made.pages.map((p) => ({
          ...p,
          sections: p.sections.map((s) =>
            s.kind === "hero" ? { ...s, variant } : s
          ),
        })),
      }) as Blueprint
    const fitted = withOwnerChoices(
      {
        ...withHero("split_arch"),
        images: [
          slot("hero", "hero", "16:9", { text_side: "left" }),
          slot("card", "service_cards", "16:9"),
          slot("band", "cta_band", "4:3"),
          slot("own", "service_cards", "16:9", {
            source: "upload",
            asset_id: "20000000-0000-4000-8000-000000000009",
          }),
        ],
      } as Blueprint,
      CLEANING
    ).images
    expect(fitted.map((s) => [s.id, s.aspect, s.text_side])).toEqual([
      // An arch is portrait, and its copy sits beside it, not on it.
      ["hero", "3:4", undefined],
      ["card", "4:3", undefined],
      ["band", "21:9", undefined],
      // An owner's photo is placed as it is.
      ["own", "16:9", undefined],
    ])
    // dark_center's copy sits on the photo, so its text side stays.
    expect(
      withOwnerChoices(
        {
          ...withHero("dark_center"),
          images: [slot("hero", "hero", "4:3", { text_side: "left" })],
        } as Blueprint,
        CLEANING
      ).images[0]
    ).toMatchObject({ aspect: "16:9", text_side: "left" })
    expect(
      plannerPrompt({ facts: CLEANING, recent: [], previous: null }).system
    ).toContain("one photographer's shot list")
  })
})

describe("page header photos", () => {
  const header = (id: string, page: string) => ({
    id,
    page,
    section: "hero",
    aspect: "16:9",
    resolution: "1K",
    subject: "x",
    alt: "x",
    source: "generated",
  })
  const fallback = (facts: FactRecord[]) =>
    fallbackBlueprint({ facts, recent: [], library: LIBRARY })

  it("plans a photo for each service page, with uploads or without", () => {
    const made = fallback(CLEANING)
    expect(made.images.map((s) => [s.id, s.page, s.section])).toEqual([
      ["home_hero", "home", "hero"],
      ["service_1_card", "home", "service_cards"],
      ["service_2_card", "home", "service_cards"],
      ["service_1_hero", "service", "hero"],
      ["service_2_hero", "service", "hero"],
    ])
    expect(problems(made, { facts: CLEANING, library: LIBRARY })).toEqual([])
    // The page's hero frames the photo it has, at the shape the slot is drawn.
    const hero = made.pages
      .find((p) => p.page === "service")
      ?.sections.find((s) => s.kind === "hero")
    expect(hero?.variant).toBe("split_frame")
    expect(made.images[3]?.aspect).toBe("4:3")
    const owned = fallback([
      ...CLEANING,
      fact("media.uploads", {
        items: [
          {
            id: "20000000-0000-4000-8000-000000000009",
            name: "kitchen.jpg",
            content_type: "image/jpeg",
            bytes: 1000,
          },
        ],
      }),
    ])
    // The owner's photos cover the home page; a service's header is still drawn.
    expect(
      owned.images.filter((s) => s.page === "service").map((s) => s.source)
    ).toEqual(["generated", "generated"])
  })

  it("puts back the about page's principles and visit steps when a plan drops them", () => {
    const made = fallback(CLEANING)
    const dropped = {
      ...made,
      pages: made.pages.map((p) =>
        p.page === "about"
          ? {
              ...p,
              sections: p.sections.filter(
                (s) => s.kind !== "value_props" && s.kind !== "steps"
              ),
            }
          : p
      ),
    } as Blueprint
    const about = (shown: Blueprint) =>
      shown.pages.find((p) => p.page === "about")?.sections ?? []
    expect(about(dropped).map((s) => s.kind)).not.toContain("steps")
    const kept = about(withOwnerChoices(dropped, CLEANING))
    const kinds = kept.map((s) => s.kind)
    expect(kinds.slice(-3)).toEqual(["value_props", "steps", "cta_band"])
    // The home page's variant, so the site keeps one look.
    const home = made.pages.find((p) => p.page === "home")?.sections
    expect(kept.find((s) => s.kind === "steps")?.variant).toBe(
      home?.find((s) => s.kind === "steps")?.variant
    )
    // A plan that has them is left as it is.
    expect(about(withOwnerChoices(made, CLEANING))).toEqual(about(made))
  })

  it("keeps a page with no photo as it was, and draws about and contact last", () => {
    const made = fallback(CLEANING)
    const ordered = withOwnerChoices(
      {
        ...made,
        images: [
          header("about_hero", "about"),
          header("contact_hero", "contact"),
          ...made.images,
        ],
      } as Blueprint,
      CLEANING
    )
    expect(ordered.images.map((s) => s.id)).toEqual([
      "home_hero",
      "service_1_card",
      "service_2_card",
      "service_1_hero",
      "service_2_hero",
      "about_hero",
      "contact_hero",
    ])
    const variantOf = (page: string) =>
      ordered.pages
        .find((p) => p.page === page)
        ?.sections.find((s) => s.kind === "hero")?.variant
    expect(variantOf("about")).toBe("split_frame")
    expect(variantOf("quote")).toBe("text_led")
  })

  it("plans the plain header for an inner page with no photo slot", () => {
    const made = fallback(CLEANING)
    const named = {
      ...made,
      pages: made.pages.map((p) =>
        p.page === "home"
          ? p
          : {
              ...p,
              sections: p.sections.map((s) =>
                s.kind === "hero" ? { ...s, variant: "wash" } : s
              ),
            }
      ),
      images: [...made.images, header("about_hero", "about")],
    } as Blueprint
    const planned = withOwnerChoices(named, CLEANING)
    const variantOf = (page: string) =>
      planned.pages
        .find((p) => p.page === page)
        ?.sections.find((s) => s.kind === "hero")?.variant
    // About and the service pages have a slot and keep their variant; Contact has none.
    expect(variantOf("about")).toBe("wash")
    expect(variantOf("service")).toBe("wash")
    expect(variantOf("contact")).toBe("text_led")
    expect(variantOf("home")).not.toBe("text_led")
  })

  it("names the site fields a header photo goes in", () => {
    const made = fallback(CLEANING)
    const lines = blueprintLines({
      ...made,
      images: [...made.images, header("about_hero", "about")],
    } as Blueprint).join("\n")
    expect(lines).toContain(
      "(site.service2HeaderImage and site.service2HeaderImageAlt)"
    )
    expect(lines).toContain("(site.service2Image and site.service2ImageAlt)")
    expect(lines).toContain("(site.aboutImage and site.aboutImageAlt)")
  })

  it("spends eight photos on the hero and cards first, then headers, and a page past the budget has none", () => {
    const six = fallback([
      ...CLEANING.filter((f) => f.key !== "business.offerings"),
      fact("business.offerings", {
        items: ["One", "Two", "Three", "Four", "Five", "Six"],
      }),
    ])
    const ordered = withOwnerChoices(
      {
        ...six,
        images: [
          ...six.images,
          header("about_hero", "about"),
          header("contact_hero", "contact"),
        ],
      } as Blueprint,
      CLEANING
    )
    // Hero and six cards are seven photos; one header fits, nothing after it.
    expect(ordered.images.map((s) => s.id)).toEqual([
      "home_hero",
      ...[1, 2, 3, 4, 5, 6].map((n) => `service_${n}_card`),
      "service_1_hero",
    ])
    // Fewer services leave room for every header and then About.
    const four = fallback([
      ...CLEANING.filter((f) => f.key !== "business.offerings"),
      fact("business.offerings", { items: ["One", "Two", "Three"] }),
    ])
    const kept = withOwnerChoices(
      {
        ...four,
        images: [...four.images, header("about_hero", "about")],
      } as Blueprint,
      CLEANING
    ).images.map((s) => s.id)
    expect(kept).toHaveLength(8)
    expect(kept.at(-1)).toBe("about_hero")
  })

  it("tells the model about header photos", () => {
    const { system } = plannerPrompt({
      facts: CLEANING,
      recent: [],
      previous: null,
    })
    expect(system).toContain("service_<n>_hero")
    expect(system).toContain("never reuses its card's photo")
    expect(system).toContain("about_hero and contact_hero")
  })
})

describe("pages the starter has no file for", () => {
  const photo = (n: number) => ({
    id: `20000000-0000-4000-8000-00000000000${n}`,
    name: `job${n}.jpg`,
    content_type: "image/jpeg",
    bytes: 1000,
    alt: `Finished job ${n}`,
  })
  const UPLOADS = fact("media.uploads", { items: [1, 2, 3, 4].map(photo) })
  const picking = (ids: string[], ...more: FactRecord[]) => [
    ...CLEANING,
    fact("site.pages", { ids }),
    ...more,
  ]
  const fallback = (facts: FactRecord[]) => {
    const made = fallbackBlueprint({ facts, recent: [], library: LIBRARY })
    expect(problems(made, { facts, library: LIBRARY })).toEqual([])
    return made
  }
  const home = (made: Blueprint) =>
    made.pages.find((p) => p.page === "home")?.sections.map((s) => s.kind) ?? []

  it("makes a gallery from the owner's photos, never the hero's alone", () => {
    const made = fallback(picking(["home", "gallery"], UPLOADS))
    expect(made.pages.map((p) => p.page)).toEqual(["home", "quote"])
    expect(home(made)).toContain("gallery")
    expect(
      made.images.filter((i) => i.section === "gallery").map((i) => i.source)
    ).toEqual(["upload", "upload", "upload"])
    expect(made.features).toContain(
      "Your gallery is a section on the home page, built from your own photos."
    )
  })

  it("plans the pages an owner typed, with FAQ on the home page and a word on the gallery", () => {
    // The 2026-10-15 run's words, as the tray now stores them.
    const words =
      "Home, Services, About, Gallery, FAQ, Contact, Request a quote"
    const made = fallback([
      ...CLEANING,
      fact("site.pages", {
        ids: [
          "home",
          "services",
          "about",
          "gallery",
          "faq",
          "contact",
          "quote",
        ],
        custom: words,
      }),
    ])
    expect(made.pages.map((p) => p.page)).toEqual([
      "home",
      "about",
      "services",
      "service",
      "contact",
      "quote",
    ])
    expect(home(made)).toContain("faq")
    expect(made.features).toContain("Your FAQ is a section on the home page.")
    expect(made.features.join("\n")).toMatch(
      /gallery needs photos of your work/
    )
  })

  it("leaves the gallery out without photos and says so", () => {
    const made = fallback(picking(["home", "gallery"]))
    expect(home(made)).not.toContain("gallery")
    expect(made.images.filter((i) => i.section === "gallery")).toEqual([])
    expect(made.features.join("\n")).toMatch(
      /gallery needs photos of your work/
    )
  })

  it("refuses a planned gallery with no photos, and one with no slot", () => {
    const withGallery = fallback(picking(["home", "gallery"], UPLOADS))
    const none = picking(["home", "gallery"])
    expect(
      problems(withGallery, { facts: none, library: LIBRARY }).join("\n")
    ).toMatch(/gallery needs the owner's photos/)
    expect(
      problems(
        { ...withGallery, images: [] },
        { facts: picking(["home", "gallery"], UPLOADS), library: LIBRARY }
      ).join("\n")
    ).toMatch(/gallery has no image slot/)
  })

  it.each([
    ["testimonials", "Your reviews are a section on the home page."],
    ["faq", "Your FAQ is a section on the home page."],
  ])("makes %s a home page section and says so", (id, line) => {
    const made = fallback(picking(["home", id]))
    expect(home(made)).toContain(id)
    expect(made.features).toContain(line)
    expect(made.pages.map((p) => p.page)).not.toContain(id)
  })

  it("puts a section the pack's home order lacks where it belongs", () => {
    const legal = [
      ...LEGAL,
      fact("site.pages", { ids: ["home", "gallery", "faq"] }),
      UPLOADS,
    ]
    const kinds = home(fallback(legal))
    expect(kinds.indexOf("gallery")).toBe(kinds.indexOf("service_area") - 1)
    expect(kinds.indexOf("faq")).toBeLessThan(kinds.indexOf("cta_band"))
  })

  it("keeps all three for 'Everything' and loses none of the pages", () => {
    const everything = [
      "home",
      "services",
      "about",
      "gallery",
      "testimonials",
      "faq",
      "service_area",
      "contact",
      "quote",
    ]
    const made = fallback(picking(everything, UPLOADS))
    expect(made.pages.map((p) => p.page)).toEqual([
      "home",
      "about",
      "services",
      "service",
      "service_area",
      "contact",
      "quote",
    ])
    expect(home(made)).toEqual(
      expect.arrayContaining(["gallery", "testimonials", "faq"])
    )
    expect(
      made.features.filter((l) => /section on the home page/.test(l))
    ).toHaveLength(3)
    expect(made.features.length).toBeLessThanOrEqual(10)
  })

  it("drops the model's own line about a picked section, which the note covers", () => {
    const facts = picking(["home", "testimonials"])
    const made = fallback(facts)
    const said = withOwnerChoices(
      {
        ...made,
        features: [
          "A customer review spot on the home page, filled only with reviews you give us.",
          "A quote form with your own questions.",
          ...made.features,
        ],
      },
      facts
    ).features
    expect(said.join("\n")).not.toMatch(/review spot/)
    expect(said).toContain("Your reviews are a section on the home page.")
    expect(said).toContain("A quote form with your own questions.")
  })

  it("keeps the lines once on a re-plan and asks the model for the sections", () => {
    const facts = picking(["home", "gallery", "faq"], UPLOADS)
    const made = fallback(facts)
    expect(withOwnerChoices(made, facts).features).toEqual(made.features)
    const prompt = plannerPrompt({ facts, recent: [], previous: null })
    expect(prompt.user).toContain(
      "Picked as home page sections: gallery (planned)"
    )
    // A model plan without the picked section is sent back.
    const without = {
      ...made,
      pages: made.pages.map((p) =>
        p.page === "home"
          ? { ...p, sections: p.sections.filter((s) => s.kind !== "faq") }
          : p
      ),
    }
    expect(problems(without, { facts, library: LIBRARY }).join("\n")).toMatch(
      /picked faq/
    )
  })
})

describe("the checks a schema cannot make", () => {
  const good = fallbackBlueprint({
    facts: CLEANING,
    recent: [],
    library: LIBRARY,
  })
  const check = (made: Blueprint) =>
    problems(made, { facts: CLEANING, library: LIBRARY })

  it("finds a missing quote page, a repeat and a kind a page cannot hold", () => {
    const home = good.pages[0] as Blueprint["pages"][number]
    const found = check({
      ...good,
      pages: [
        home,
        home,
        {
          page: "contact",
          sections: [
            {
              kind: "gallery",
              variant: "default",
              purpose: "x",
              content_notes: null,
            },
          ],
        },
      ],
    })
    expect(found.join("\n")).toMatch(/listed twice/)
    expect(found.join("\n")).toMatch(/pages missing: about, services/)
    expect(found.join("\n")).toMatch(/contact cannot hold gallery/)
  })

  it("refuses a generated photo where a photo is a claim, and an unknown upload", () => {
    const found = check({
      ...good,
      images: [
        {
          id: "work",
          page: "home",
          section: "gallery",
          aspect: "4:3",
          resolution: "1K",
          subject: "A finished kitchen",
          alt: "A kitchen",
          source: "generated",
        },
        {
          id: "mine",
          page: "home",
          section: "hero",
          aspect: "4:3",
          resolution: "1K",
          subject: "A room",
          alt: "A room",
          source: "upload",
          asset_id: "20000000-0000-4000-8000-000000000009",
        },
      ],
    })
    expect(found.join("\n")).toMatch(/images.work is generated/)
    expect(found.join("\n")).toMatch(/mine names an upload/)
  })

  it("refuses a direction outside the library and a plan that moved three axes", () => {
    expect(check({ ...good, direction: "made_up" })[0]).toMatch(
      /not in the library/
    )
    const moved = {
      ...good,
      fonts: "syne_jakarta" as const,
      palette: { kind: "preset" as const, id: "onyx" as const },
      pages: good.pages.map((p) =>
        p.page === "home"
          ? {
              ...p,
              sections: p.sections.map((s) =>
                s.kind === "hero" ? { ...s, variant: "text_led" } : s
              ),
            }
          : p
      ),
    } as Blueprint
    expect(check(moved).join("\n")).toMatch(/3 axes differ/)
  })
})

describe("planning a build", () => {
  const replyFor = (facts: FactRecord[]) =>
    JSON.stringify(fallbackBlueprint({ facts, recent: [], library: LIBRARY }))

  it("gives one business per pack its own valid Blueprint from the model", async () => {
    const made = []
    for (const facts of [CLEANING, LEGAL, CHAUFFEUR]) {
      const { complete } = scripted([replyFor(facts)])
      made.push(
        await plan({
          complete,
          route: ROUTE,
          sessionId: "s",
          facts,
          recent: [],
          previous: null,
          library: LIBRARY,
        })
      )
    }
    expect(made.map((m) => m.source)).toEqual(["model", "model", "model"])
    expect(new Set(made.map((m) => m.blueprint.direction)).size).toBe(3)
  })

  it("retries once with what was wrong, then takes the reply", async () => {
    const { calls, complete } = scripted([
      '{"direction": "calm_daylight"}',
      `Here it is: ${replyFor(CLEANING)}`,
    ])
    const made = await plan({
      complete,
      route: ROUTE,
      sessionId: "s",
      facts: CLEANING,
      recent: [],
      previous: null,
      library: LIBRARY,
    })
    expect(made.source).toBe("model")
    expect(made.calls).toHaveLength(2)
    expect(calls[1]?.user).toContain("<previous_attempt_failed>")
    expect(calls[1]?.system).toBe(calls[0]?.system)
  })

  it("falls back to code after two failures, model errors included", async () => {
    const { complete } = scripted([new Error("503"), "not json"])
    const made = await plan({
      complete,
      route: ROUTE,
      sessionId: "s",
      facts: LEGAL,
      recent: [],
      previous: null,
      library: LIBRARY,
    })
    expect(made.source).toBe("fallback")
    expect(made.errors).toHaveLength(2)
    expect(made.blueprint.direction).toBe("counsel")
  })

  it("applies the owner's palette over the model's", async () => {
    const facts = [...CLEANING, fact("site.palette", { id: "sage" })]
    const { complete } = scripted([replyFor(CLEANING)])
    const made = await plan({
      complete,
      route: ROUTE,
      sessionId: "s",
      facts,
      recent: [],
      previous: null,
      library: LIBRARY,
    })
    expect(made.blueprint.palette).toEqual({ kind: "preset", id: "sage" })
  })

  it("re-plans from the current Blueprint and the owner's words, and keeps it on failure", async () => {
    const current = fallbackBlueprint({
      facts: CLEANING,
      recent: [],
      library: LIBRARY,
    })
    const { calls, complete } = scripted([new Error("x"), new Error("y")])
    const made = await plan({
      complete,
      route: ROUTE,
      sessionId: "s",
      facts: CLEANING,
      recent: [],
      previous: { plan: current, note: "Make it darker" },
      library: LIBRARY,
    })
    expect(calls[0]?.user).toContain("This is a re-plan")
    expect(calls[0]?.user).toContain('"Make it darker"')
    expect(made).toMatchObject({ source: "fallback", blueprint: current })
  })
})

describe("the prompt", () => {
  it("puts the stable parts in the system part and the diversity note last", () => {
    const recent = [
      { direction: "calm_daylight", hero: "wash", services: "photo_cards" },
      { direction: "calm_daylight", hero: "wash", services: "photo_cards" },
    ]
    const a = plannerPrompt({
      facts: CLEANING,
      recent,
      previous: null,
      library: LIBRARY,
    })
    const b = plannerPrompt({
      facts: business("cleaning", "Other Co (fictional)"),
      recent: [],
      previous: null,
      library: LIBRARY,
    })
    expect(a.system).toBe(b.system)
    expect(a.system).toContain("- after_dark (After dark")
    expect(a.system).toContain("a photo slot for every service")
    // No uploads is no reason for a bare hero: the planner is told to spend the slots.
    expect(a.system).toContain("Plan up to 8 slots in all")
    expect(a.user).toContain(
      "- calm_daylight + hero wash + services photo_cards (2)"
    )
    expect(diversityNote([], "cleaning")).toEqual([])
  })
})

describe("the Blueprint as the starter's layout", () => {
  it("writes every variant out, an inner page's hero included", () => {
    const made = fallbackBlueprint({
      facts: LEGAL,
      recent: [],
      library: LIBRARY,
    })
    const layout = blueprintLayout(made)
    expect(layout.home?.[0]).toEqual({ kind: "hero", variant: "text_led" })
    expect(layout.about?.[0]).toEqual({ kind: "hero", variant: "text_led" })
    expect(layout.quote).toEqual([
      { kind: "hero", variant: "text_led" },
      { kind: "quote_form", variant: "default" },
    ])
  })
})
