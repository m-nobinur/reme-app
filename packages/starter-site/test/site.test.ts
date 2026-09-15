import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { SiteFields } from "@workspace/contracts"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { fields, site } from "../src/site-config"
import {
  type Built,
  build,
  clean,
  jsonLdOf,
  ORIGIN,
  type Page,
  ROOT,
  readPages,
} from "./build"
import { ALLOWED, validateJsonLd } from "./jsonld"

const REQUIRED_FACTS = [
  "business.name",
  "business.phone",
  "business.email",
  "hours.weekday",
  "service_area.radius",
  "pricing.standard_clean_hourly",
]

/**
 * The golden fixture business, rendered the way the Developer renders facts
 * into the config. Fictional: a 555 number and an .invalid address.
 */
const FILLED: Record<string, string> = {
  ...site,
  businessName: "BrightClean",
  phone: "+15550142",
  email: "hello@brightclean.invalid",
  weekdayHours: "08:00 to 17:00",
  serviceArea: "Within 25 km of Fairhaven",
  standardCleanHourly: "$35.00 an hour",
  openingHours: "Mo-Fr 08:00-17:00",
  areaServed: "Fairhaven",
}

const PLANTED = `---
import Base from "../layouts/Base.astro"
---

<Base title="" />
`

// Each value is its own key between markers, so any text left after the
// markers are removed was written into a template rather than read from here.
const MARKED = Object.fromEntries(
  Object.keys(site).map((key) => [key, `«${key}»`])
)

let filled: Built | undefined
let planted: Built | undefined
let marked: Built | undefined

beforeAll(async () => {
  ;[filled, planted, marked] = await Promise.all([
    build({ site: FILLED }),
    build({
      site: { ...FILLED, phone: "", email: "" },
      pages: { "planted.astro": PLANTED },
      remove: ["quote.astro", "booking.astro"],
    }),
    build({ site: MARKED }),
  ])
}, 120_000)

afterAll(() => {
  for (const built of [filled, planted, marked]) clean(built)
})

const pagesOf = (built: Built | undefined) => {
  if (!built) throw new Error("the build did not run")
  return readPages(built.dist)
}
const fileOf = (built: Built | undefined, file: string) => {
  if (!built) throw new Error("the build did not run")
  return readFileSync(join(built.dist, file), "utf8")
}
const sitemapUrls = (xml: string) =>
  [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])
const urlOf = (file: string) =>
  `${ORIGIN}/${file.replace(/index\.html$/, "").replace(/\.html$/, "/")}`

describe("the site config", () => {
  test("declares one SiteField for every site string", () => {
    expect(() => SiteFields.parse(fields)).not.toThrow()
    expect(Object.keys(fields)).toEqual(Object.keys(site))
  })

  test("asks for the required facts first, in order", () => {
    const entries = Object.values(fields)
    const required = entries.flatMap((field) =>
      field.kind === "fact" && field.required ? [field.fact_key] : []
    )
    expect(required).toEqual(REQUIRED_FACTS)
    expect(
      entries
        .slice(0, REQUIRED_FACTS.length)
        .map((field) => (field.kind === "fact" ? field.fact_key : ""))
    ).toEqual(REQUIRED_FACTS)
  })

  test("ships every fact field empty", () => {
    const filledFacts = Object.entries(fields).filter(
      ([key, field]) =>
        field.kind === "fact" && site[key as keyof typeof site] !== ""
    )
    expect(filledFacts).toEqual([])
  })
})

describe("the site as shipped, with no facts", () => {
  test("renders no claim: no JSON-LD, no tel or mailto link, no price, time, email or phone", () => {
    const findings = readPages(join(ROOT, "dist")).flatMap((page) => [
      ...jsonLdOf(page).map(() => `${page.file}: JSON-LD`),
      ...page.elements
        .filter((el) => /^(tel|mailto):/.test(el.attrs.href ?? ""))
        .map((el) => `${page.file}: ${el.attrs.href}`),
      ...page.texts
        .filter((text) =>
          /[$£€]\s?\d|\b\d{1,2}:\d{2}\b|@|\+?\d[\d\s().-]{6,}\d/.test(text)
        )
        .map((text) => `${page.file}: ${text}`),
    ])
    expect(findings).toEqual([])
  })
})

describe("structured data", () => {
  test("every page validates against schema.org with schema-dts", () => {
    const items = pagesOf(filled).flatMap((page) =>
      jsonLdOf(page).map((value) => ({ where: page.file, value }))
    )
    const report = pagesOf(filled).map(
      (page) =>
        `${page.file}: ${
          jsonLdOf(page)
            .map((item) => item["@type"])
            .join(", ") || "none"
        }`
    )
    console.log(
      `structured data, ${items.length} item(s)\n  ${report.join("\n  ")}`
    )

    expect(items.length).toBeGreaterThan(0)
    expect(new Set(items.map((item) => item.value["@type"]))).toEqual(
      new Set(["WebSite", "LocalBusiness", "Service"])
    )
    for (const { value } of items) {
      expect(ALLOWED).toContain(value["@type"])
      expect(value.name).toBeTruthy()
    }
    expect(validateJsonLd(items)).toEqual([])
  }, 60_000)

  test("the validator rejects what schema.org does not define", () => {
    const problems = validateJsonLd([
      {
        where: "planted",
        value: {
          "@context": "https://schema.org",
          "@type": "LocalBusiness",
          name: "Planted",
          phoneNumber: "+15550100",
        },
      },
      {
        where: "planted",
        value: {
          "@context": "https://schema.org",
          "@type": "Product",
          name: "x",
        },
      },
    ])
    expect(problems.some((line) => line.includes("phoneNumber"))).toBe(true)
    expect(problems.some((line) => line.includes("Product"))).toBe(true)
  }, 60_000)

  test("leaves out a fact-bearing property whose field is empty", () => {
    const business = pagesOf(planted)
      .flatMap(jsonLdOf)
      .filter((item) => item["@type"] === "LocalBusiness")
    expect(business.length).toBeGreaterThan(0)
    for (const item of business) {
      expect(item).not.toHaveProperty("telephone")
      expect(item).not.toHaveProperty("email")
      expect(item).toHaveProperty("openingHours")
    }
  })
})

describe("the head", () => {
  test("every page has a title, a canonical URL on the origin and Open Graph tags", () => {
    for (const page of pagesOf(filled)) {
      const meta = (property: string) =>
        page.elements.find(
          (el) => el.tag === "meta" && el.attrs.property === property
        )?.attrs.content
      const canonical = page.elements.find(
        (el) => el.tag === "link" && el.attrs.rel === "canonical"
      )?.attrs.href
      expect(page.texts.length, page.file).toBeGreaterThan(0)
      expect(canonical, page.file).toBe(urlOf(page.file))
      expect(meta("og:url"), page.file).toBe(canonical)
      expect(meta("og:title"), page.file).toBeTruthy()
      expect(meta("og:site_name"), page.file).toBe("BrightClean")
    }
  })
})

describe("routes", () => {
  test("the sitemap lists every built page and nothing else", () => {
    const pages = pagesOf(filled)
      .map((page) => page.file)
      .filter((file) => file !== "404.html")
      .map(urlOf)
      .sort((a, b) => a.localeCompare(b))
    expect(
      sitemapUrls(fileOf(filled, "sitemap.xml")).sort((a, b) =>
        a.localeCompare(b)
      )
    ).toEqual(pages)
  })

  test("a page added to src/pages reaches the sitemap without an edit", () => {
    expect(sitemapUrls(fileOf(planted, "sitemap.xml"))).toContain(
      `${ORIGIN}/planted/`
    )
  })

  test("a page left out leaves both navigation and the sitemap", () => {
    const urls = sitemapUrls(fileOf(planted, "sitemap.xml"))
    const hrefs = pagesOf(planted).flatMap((page) =>
      page.elements.map((el) => el.attrs.href ?? "")
    )
    for (const path of ["/quote/", "/booking/"]) {
      expect(urls).not.toContain(`${ORIGIN}${path}`)
      expect(hrefs).not.toContain(path)
    }
    expect(hrefs).toContain("/contact/")
  })

  test("robots.txt allows crawling and names the sitemap", () => {
    expect(fileOf(filled, "robots.txt")).toBe(
      `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`
    )
  })
})

describe("templates", () => {
  test("every string a visitor reads comes from the site config", () => {
    const CLAIM_ATTRIBUTES = ["alt", "title", "aria-label", "placeholder"]
    const READ_META = new Set([
      "description",
      "og:title",
      "og:description",
      "og:site_name",
    ])
    const leftovers = (page: Page) => [
      ...page.texts,
      ...page.elements.flatMap((el) => [
        ...CLAIM_ATTRIBUTES.flatMap((name) =>
          el.attrs[name] === undefined ? [] : [el.attrs[name]]
        ),
        ...(el.tag === "meta" &&
        READ_META.has(el.attrs.name ?? el.attrs.property ?? "")
          ? [el.attrs.content ?? ""]
          : []),
      ]),
    ]
    const inline = pagesOf(marked).flatMap((page) =>
      leftovers(page)
        .map((text) => text.replace(/«[A-Za-z]+»/g, ""))
        .filter((rest) => /[\p{L}\p{N}]/u.test(rest))
        .map((rest) => `${page.file}: "${rest.trim()}"`)
    )
    expect(inline).toEqual([])
  })

  test("every page renders with no JavaScript", () => {
    for (const built of [filled, planted, marked]) {
      if (!built) throw new Error("the build did not run")
      const scripts = readPages(built.dist).flatMap((page) =>
        page.scripts
          .filter((script) => script.type !== "application/ld+json")
          .map(() => page.file)
      )
      const bundles = readdirSync(built.dist, { recursive: true })
        .map(String)
        .filter((file) => /\.m?js$/.test(file))
      expect(scripts).toEqual([])
      expect(bundles).toEqual([])
    }
  })
})
