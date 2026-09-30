import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { SiteFields } from "@workspace/contracts"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { fields, quoteForm, site } from "../src/site-config"
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
import { FILLED } from "./fixture"
import { ALLOWED, validateJsonLd } from "./jsonld"

const REQUIRED_FACTS = [
  "business.name",
  "business.phone",
  "business.email",
  "hours.weekday",
  "service_area.radius",
]

// The planted page carries an empty Hero, which the starter's own pages cannot
// show: every page ships with its heading field set.
const PLANTED = `---
import Hero from "../components/Hero/Hero.astro"
import Base from "../layouts/Base.astro"
---

<Base title=""><Hero heading="" /></Base>
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

/**
 * Every component that decides for itself whether to render: the class it
 * wraps itself in, and something the filled fixture puts inside it. The
 * shipped build has none of their fields set, so none of them may appear in
 * it; the filled build has all of them set, so all of them must.
 */
const SECTIONS: { name: string; selector: string; shows: string }[] = [
  { name: "Stats", selector: "stats", shows: "12" },
  { name: "ValueProps", selector: "value-props", shows: "The same cleaner" },
  { name: "ServiceCards", selector: "service-cards", shows: "Weekly clean" },
  { name: "Steps", selector: "steps", shows: "Tell us about the home" },
  {
    name: "Testimonials",
    selector: "testimonials",
    shows: "They have never missed a week.",
  },
  {
    name: "Gallery",
    selector: "gallery",
    shows: "A kitchen worktop after a clean",
  },
  { name: "Faq", selector: "faq", shows: "Do I need to be in?" },
  { name: "CtaBand", selector: "cta-band", shows: "Ready for a clean home?" },
  {
    name: "ContactDetails",
    selector: "contact-details",
    shows: "+15550142",
  },
  { name: "QuoteForm", selector: "quote-form", shows: "Send quote request" },
]

const hasClass = (pages: Page[], name: string) =>
  pages.some((page) =>
    page.elements.some((el) => (el.attrs.class ?? "").split(" ").includes(name))
  )
/** What a visitor reads, the alt text of any image included. */
const visible = (pages: Page[]) =>
  pages.flatMap((page) => [
    ...page.texts,
    ...page.elements.flatMap((el) => (el.attrs.alt ? [el.attrs.alt] : [])),
  ])

describe("a component with nothing to show", () => {
  const shipped = readPages(join(ROOT, "dist"))

  for (const section of SECTIONS) {
    test(`${section.name} renders nothing`, () => {
      expect(hasClass(shipped, section.selector)).toBe(false)
    })
  }

  test("Hero renders nothing", () => {
    const page = pagesOf(planted).filter((p) => p.file === "planted/index.html")
    expect(page).toHaveLength(1)
    expect(hasClass(page, "hero")).toBe(false)
  })
})

describe("a component with its fields filled", () => {
  for (const section of SECTIONS) {
    test(`${section.name} renders`, () => {
      const pages = pagesOf(filled)
      expect(hasClass(pages, section.selector)).toBe(true)
      expect(visible(pages)).toContain(section.shows)
    })
  }

  test("Hero renders", () => {
    const pages = pagesOf(filled)
    expect(hasClass(pages, "hero")).toBe(true)
    expect(visible(pages)).toContain("A home you come back to")
  })
})

describe("the quote form", () => {
  const page = () => {
    const found = pagesOf(filled).find((p) => p.file === "quote/index.html")
    if (!found) throw new Error("no quote page")
    return found
  }

  test("renders every configured field with its label, hint and required flag", () => {
    const { elements, texts } = page()
    for (const field of quoteForm.flatMap((group) => group.fields)) {
      const id = `quote-${field.name}`
      const control = elements.find((el) => el.attrs.id === id)
      expect(control, id).toBeDefined()
      expect(control?.attrs.name, id).toBe(field.name)
      expect("required" in (control?.attrs ?? {}), id).toBe(field.required)
      expect(
        elements.some((el) => el.tag === "label" && el.attrs.for === id),
        id
      ).toBe(true)
      expect(texts, id).toContain(FILLED[field.label])
      if (field.hint) {
        expect(control?.attrs["aria-describedby"], id).toBe(`${id}-hint`)
        expect(texts, id).toContain(FILLED[field.hint])
      }
    }
    for (const group of quoteForm) {
      expect(texts).toContain(FILLED[group.legend])
    }
  })

  test("offers the services as the choices, and sends by email until there is an endpoint", () => {
    const { elements, texts } = page()
    expect(texts).toEqual(
      expect.arrayContaining(["Weekly clean", "Deep clean", "End of tenancy"])
    )
    const form = elements.find((el) => el.tag === "form")
    expect(form?.attrs.action).toBe(
      "mailto:hello@brightclean.invalid?subject=Quote%20request"
    )
    expect(form?.attrs.enctype).toBe("text/plain")
  })

  test("is the primary action in the header, the hero and the closing band", () => {
    const home = pagesOf(filled).find((p) => p.file === "index.html")
    const primary = (home?.elements ?? []).filter(
      (el) =>
        (el.attrs.class ?? "").split(" ").includes("action-primary") &&
        el.tag === "a"
    )
    expect(primary.map((el) => el.attrs.href)).toEqual([
      "/quote/",
      "/quote/",
      "/quote/",
    ])
  })
})

describe("the page recipes", () => {
  const recipes = JSON.parse(
    readFileSync(join(ROOT, "src/recipes.json"), "utf8")
  ) as {
    packs: Record<
      string,
      {
        recipes: { page: string; components: string[]; fields: string[] }[]
      }
    >
  }
  const all = Object.values(recipes.packs).flatMap((pack) => pack.recipes)

  test("name a page that exists, components that exist and fields that exist", () => {
    expect(all.length).toBeGreaterThan(0)
    const components = readdirSync(join(ROOT, "src/components"))
    for (const recipe of all) {
      expect(existsSync(join(ROOT, recipe.page)), recipe.page).toBe(true)
      for (const component of recipe.components) {
        expect(components, recipe.page).toContain(component)
      }
      for (const field of recipe.fields) {
        expect(Object.keys(site), recipe.page).toContain(field)
      }
    }
  })

  test("list the components their page actually renders", () => {
    for (const recipe of all) {
      const source = readFileSync(join(ROOT, recipe.page), "utf8")
      const used = [...source.matchAll(/<([A-Z]\w+)/g)].map((match) =>
        String(match[1])
      )
      expect(new Set(recipe.components), recipe.page).toEqual(
        new Set(used.filter((name) => name !== "Base"))
      )
    }
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
      new Set(["WebSite", "LocalBusiness"])
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
        .map((text) => text.replace(/«[A-Za-z0-9]+»/g, ""))
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
