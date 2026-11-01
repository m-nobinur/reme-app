import { type Blueprint, PageDocument } from "@workspace/contracts"
import { site } from "@workspace/starter-site/site-config"
import { describe, expect, it } from "vitest"
import { readSite } from "../src/critic.ts"
import {
  assemble,
  documentFile,
  PAGE_FIELDS,
  skeletons,
  slotPlaces,
  slotValue,
  type Written,
  whereIs,
  wordsProblem,
} from "../src/documents.ts"
import { siteValues } from "../src/fanout.ts"

const section = (kind: string, variant: string) => ({
  kind,
  variant,
  purpose: "x",
  content_notes: null,
})
const PLAN = {
  pages: [
    {
      page: "home",
      sections: [
        section("hero", "wash"),
        section("faq", "split"),
        section("cta_band", "solid"),
      ],
    },
    {
      page: "services",
      sections: [
        section("hero", "text_led"),
        section("service_cards", "photo_cards"),
      ],
    },
    {
      page: "service",
      sections: [section("hero", "split_frame"), section("faq", "stacked")],
    },
  ],
} as unknown as Blueprint

/** The config as the writers see it, the home writer's names in it. */
const CONFIG = `const values = {\n${Object.entries({
  ...site,
  businessName: "BrightClean",
  service1Name: "Deep clean",
  service1Body: "Top to bottom.",
})
  .map(([k, v]) => `  ${k}: ${JSON.stringify(v)},`)
  .join("\n")}\n}\n`
const VALUES = siteValues(CONFIG)
const PAGES = skeletons(PLAN)
const faq = (question: string, answer: string) => ({
  blocks: [
    {
      id: "faq-questions",
      type: "faq" as const,
      provenance: "trade" as const,
      items: [{ question, answer }],
    },
  ],
})
const WRITTEN: Record<string, Written> = {
  "home.json": {
    title: "Weekly cleaning in Fairhaven | BrightClean",
    sections: {
      hero: { heading: "Weekly cleaning in Fairhaven" },
      faq: faq("Do I need to be in?", "No. Most clients leave a key."),
    },
  },
  "services/1.json": {
    sections: {
      hero: { heading: "Deep cleaning in Fairhaven" },
      faq: faq("How long does it take?", "A day for most homes."),
    },
  },
}
const DOCS = Object.fromEntries(
  Object.entries(PAGES).flatMap(([file, skeleton]) => {
    const at = documentFile(file, VALUES)
    return at ? [[at.path, assemble(skeleton, WRITTEN[file], at.slug)]] : []
  })
)

describe("the writers' skeletons", () => {
  it("lay out each planned page and each offering's page in the plan's sections, every word empty", () => {
    expect(Object.keys(PAGES).sort()).toEqual([
      "home.json",
      "services.json",
      ...[1, 2, 3, 4, 5, 6].map((n) => `services/${n}.json`),
    ])
    const home = PAGES["home.json"]
    expect(
      home?.sections.map((s) => [s.id, s.kind, "variant" in s && s.variant])
    ).toEqual([
      ["hero", "hero", "wash"],
      ["faq", "faq", "split"],
      ["cta-band", "cta_band", "solid"],
    ])
    expect(home?.sections[0]?.blocks?.[0]).toEqual({
      id: "hero-note",
      type: "callout",
      provenance: "facts",
      text: "",
    })
    expect(
      JSON.stringify(home).match(/"(?:heading|intro|text|answer)":"[^"]+"/g)
    ).toBeNull()
  })

  it("name a service's file by its slug once the home writer names it", () => {
    expect(documentFile("services/1.json", VALUES)).toEqual({
      path: "services/deep-clean.json",
      slug: "deep-clean",
    })
    expect(documentFile("services/2.json", VALUES)).toBeNull()
    expect(documentFile("home.json", VALUES)).toEqual({ path: "home.json" })
  })

  it("assemble each page from its writers' words, a page document", () => {
    expect(Object.keys(DOCS).sort()).toEqual([
      "home.json",
      "services.json",
      "services/deep-clean.json",
    ])
    for (const doc of Object.values(DOCS)) PageDocument.parse(doc)
    expect(DOCS["services/deep-clean.json"]?.slug).toBe("deep-clean")
    expect(JSON.stringify(DOCS["home.json"])).toContain("Do I need to be in?")
    // A section nobody wrote gives no words, so the starter's seed shows it.
    expect(DOCS["services.json"]?.sections[0]).toEqual({
      id: "hero",
      kind: "hero",
      variant: "text_led",
    })
  })

  it("say what is wrong with a writer's words before anything is written", () => {
    const home = PAGES["home.json"] as PageDocument
    expect(
      wordsProblem(home, WRITTEN["home.json"] as Written, ["hero", "faq"])
    ).toBeNull()
    const wrong = wordsProblem(
      home,
      {
        sections: { hero: { blocks: [{ id: "Bad Id", type: "callout" }] } },
      } as unknown as Written,
      ["hero"]
    )
    expect(wrong).toMatch(/^- sections\.0\.blocks\.0/m)
  })

  it("keep every page slot out of the config", () => {
    for (const name of PAGE_FIELDS) expect(name in site, name).toBe(false)
  })
})

describe("slot places", () => {
  it("finds every page slot somewhere in the documents", () => {
    const lost = [...PAGE_FIELDS].filter(
      (slot) => (slotPlaces().get(slot) ?? []).length === 0
    )
    expect(lost).toEqual([])
  })

  it("names a slot's place for the lead, and none for a setting", () => {
    expect(whereIs("faq3Answer")).toBe(
      "src/content/pages/home.json, section faq, block faq-questions, items 3 answer"
    )
    expect(whereIs("service2CtaBody")).toBe(
      "src/content/pages/services/<slug of service2Name>.json, section cta-band, block cta-band-action, body"
    )
    expect(whereIs("businessName")).toBeNull()
  })

  it("reads back what the writers wrote, from the documents", () => {
    expect(slotValue("heroHeading", DOCS, VALUES)).toBe(
      "Weekly cleaning in Fairhaven"
    )
    expect(slotValue("faq1Answer", DOCS, VALUES)).toBe(
      "No. Most clients leave a key."
    )
    expect(slotValue("service1Heading", DOCS, VALUES)).toBe(
      "Deep cleaning in Fairhaven"
    )
  })
})

describe("readSite", () => {
  it("gives the critic the settings, the slots' words and the documents' sections", () => {
    const config = readSite(CONFIG, DOCS)
    expect(config.values.businessName).toBe("BrightClean")
    expect(config.values.faq1Question).toBe("Do I need to be in?")
    expect(config.layout.home).toEqual([
      { kind: "hero", variant: "wash" },
      { kind: "faq", variant: "split" },
      { kind: "cta_band", variant: "solid" },
    ])
    expect(config.layout).toMatchObject({
      service: [{ kind: "hero" }, { kind: "service_cards" }, { kind: "faq" }],
    })
  })
})
