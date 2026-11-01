import { beforeAll, describe, expect, test } from "vitest"
import { json } from "./blocks"
import { build, jsonLdOf, type Page, readPages } from "./build"
import { FILLED } from "./fixture"

/**
 * A site as a planned first build now writes it (design §3): the services
 * compared once, in one table on /services/, and each offering's own page
 * with what it covers, how to prepare and how it differs, and no process or
 * questions of its own.
 */
const trade = { provenance: "trade" } as const
const facts = { provenance: "facts" } as const
const cta = (heading: string, body: string) => ({
  id: "cta-band",
  kind: "cta_band",
  blocks: [{ ...facts, id: "cta-band-action", type: "cta", heading, body }],
})

const SERVICES = {
  page: "services",
  title: "Cleaning services across Fairhaven | Fairhaven Fresh",
  description:
    "Weekly, deep and end of tenancy cleaning across Fairhaven, compared side by side, so you can ask for a quote for the clean your home needs.",
  sections: [
    {
      id: "hero",
      kind: "hero",
      heading: "Cleaning for every kind of Fairhaven home",
      intro: "Three cleans, from a weekly visit to a full reset.",
    },
    {
      id: "service-cards",
      kind: "service_cards",
      variant: "photo_cards",
      eyebrow: "Services",
      heading: "Every clean we take on",
    },
    {
      id: "content",
      kind: "content",
      eyebrow: "Compare",
      heading: "Which clean suits your home",
      blocks: [
        {
          ...trade,
          id: "compare",
          type: "table",
          columns: ["Service", "What it usually covers", "Who it suits"],
          rows: [
            ["Weekly clean", "Kitchen, bathroom and floors", "Busy households"],
            [
              "Deep clean",
              "Inside cupboards, the oven, skirting",
              "A home due a reset",
            ],
            [
              "End of tenancy",
              "Every room, ready for check-out",
              "Tenants and landlords",
            ],
          ],
        },
      ],
    },
    cta(
      "Book the clean that fits",
      "Tell us about your home and we reply with a quote for the right clean."
    ),
  ],
}

const DEEP = {
  page: "service",
  slug: "deep-clean",
  title: "Deep cleaning in Fairhaven | Fairhaven Fresh (fictional)",
  description:
    "A deep clean for Fairhaven homes due a reset: cupboards, the oven and the corners a weekly clean skips. Ask for a quote for your home.",
  sections: [
    { id: "hero", kind: "hero", heading: "Deep cleaning for Fairhaven homes" },
    {
      id: "service-cards",
      kind: "service_cards",
      variant: "alternating",
      eyebrow: "The clean",
      heading: "What a deep clean takes on",
    },
    {
      id: "content",
      kind: "content",
      eyebrow: "Before we arrive",
      heading: "Getting your home ready",
      blocks: [
        {
          ...trade,
          id: "prepare",
          type: "checklist",
          items: [
            "Clear the worktops",
            "Empty the oven",
            "Move what you can off the floors",
          ],
        },
      ],
    },
    {
      id: "content-2",
      kind: "content",
      eyebrow: "Choosing",
      heading: "A deep clean or a weekly one",
      blocks: [
        {
          ...facts,
          id: "differs",
          type: "prose",
          markdown:
            "A deep clean reaches what a weekly visit leaves, inside the oven and behind the units. Moving out? The end of tenancy clean covers every room for check-out.",
        },
      ],
    },
    cta(
      "Book a deep clean",
      "Send the details of your home and we reply with a quote for the deep clean."
    ),
  ],
}

describe("offering pages and the services compared once", () => {
  let pages: Page[] = []
  beforeAll(async () => {
    const built = await build({
      site: FILLED,
      files: {
        "src/content/pages/services.json": json(SERVICES),
        "src/content/pages/services/deep-clean.json": json(DEEP),
      },
    })
    pages = readPages(built.dist)
  }, 300_000)
  const page = (file: string) => {
    const found = pages.find((p) => p.file === file)
    if (!found) throw new Error(`no ${file}`)
    return found
  }

  test("the services page compares every service in one table and links each page", () => {
    const services = page("services/index.html")
    expect(services.elements.filter((e) => e.tag === "table")).toHaveLength(1)
    for (const name of ["Weekly clean", "Deep clean", "End of tenancy"])
      expect(services.texts).toContain(name)
    for (const slug of ["weekly-clean", "deep-clean", "end-of-tenancy"])
      expect(services.html).toContain(`href="/services/${slug}/"`)
    expect(jsonLdOf(services).map((t) => t["@type"])).not.toContain("FAQPage")
  })

  test("an offering's page says how to prepare and how it differs, with no steps or questions", () => {
    const deep = page("services/deep-clean/index.html")
    for (const text of [
      "Getting your home ready",
      "Empty the oven",
      "A deep clean or a weekly one",
      "Deep cleaning for Fairhaven homes",
    ])
      expect(deep.texts.join(" "), text).toContain(text)
    expect(deep.html).toContain('data-copy="service_includes"')
    expect(deep.html).toContain('data-copy="service_for"')
    expect(deep.html).not.toContain('data-copy="step_body"')
    expect(deep.html).not.toContain("faq-list")
    expect(deep.html).not.toContain('data-copy="faq_answer"')
    expect(jsonLdOf(deep).map((t) => t["@type"])).toEqual(["Service"])
    // The headings run h1, then h2s, then h3s, never skipping a level.
    const levels = deep.elements
      .filter((e) => /^h[1-6]$/.test(e.tag))
      .map((e) => Number(e.tag.slice(1)))
    for (const [i, level] of levels.entries())
      expect(level - (levels[i - 1] ?? 0), `heading ${i}`).toBeLessThanOrEqual(
        1
      )
  })
})
