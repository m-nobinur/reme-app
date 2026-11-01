import { type Blueprint, PageDocument } from "@workspace/contracts"
import { site } from "@workspace/starter-site/site-config"
import { describe, expect, it } from "vitest"
import { readSite } from "../src/critic.ts"
import {
  documentFiles,
  PAGE_FIELDS,
  SHEET_MARK,
  SLOT_SHEET,
  slotPlaces,
  slotValue,
  whereIs,
} from "../src/documents.ts"
import { siteValues } from "../src/fanout.ts"
import { setValues } from "../src/write-pages.ts"

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

/** The config and the slot sheet as the writers see them, with some of each written. */
const CONFIG = `const values = {\n${Object.entries({
  ...site,
  businessName: "BrightClean",
  service1Name: "Deep clean",
  service1Body: "Top to bottom.",
})
  .map(([k, v]) => `  ${k}: ${JSON.stringify(v)},`)
  .join("\n")}\n}\n`
const WRITTEN = setValues(`${CONFIG}${SHEET_MARK}${SLOT_SHEET}`, {
  heroHeading: "Weekly cleaning in Fairhaven",
  faq1Question: "Do I need to be in?",
  faq1Answer: "No. Most clients leave a key.",
  service1Heading: "Deep cleaning in Fairhaven",
  service1Faq1Question: "How long does it take?",
  service1Faq1Answer: "A day for most homes.",
})
const docsOf = (files: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(files).map(([path, text]) => [
      path,
      PageDocument.parse(JSON.parse(text)),
    ])
  )

describe("documentFiles", () => {
  const files = documentFiles(siteValues(WRITTEN), PLAN)

  it("writes each planned page and each named service, in the plan's sections, and nothing else", () => {
    expect(Object.keys(files).sort()).toEqual([
      "home.json",
      "services.json",
      "services/deep-clean.json",
    ])
    const docs = docsOf(files)
    expect(
      docs["home.json"]?.sections.map((s) => [
        s.kind,
        "variant" in s && s.variant,
      ])
    ).toEqual([
      ["hero", "wash"],
      ["faq", "split"],
      ["cta_band", "solid"],
    ])
    expect(files["home.json"]).toContain("Weekly cleaning in Fairhaven")
    expect(files["home.json"]).toContain("Do I need to be in?")
    expect(files["services/deep-clean.json"]).toContain(
      "How long does it take?"
    )
  })

  it("leaves every page slot in the sheet, none in the config", () => {
    for (const name of PAGE_FIELDS) expect(name in site, name).toBe(false)
    const [config] = WRITTEN.split(SHEET_MARK)
    expect(config).not.toContain("Do I need to be in?")
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
    const values = siteValues(WRITTEN)
    const docs = docsOf(documentFiles(values, PLAN))
    for (const slot of ["heroHeading", "faq1Answer", "service1Heading"])
      expect(slotValue(slot, docs, values), slot).toBe(values[slot])
  })
})

describe("readSite", () => {
  it("gives the critic the settings, the slots' words and the documents' sections", () => {
    const values = siteValues(WRITTEN)
    const config = readSite(CONFIG, docsOf(documentFiles(values, PLAN)))
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
