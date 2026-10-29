import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { SiteFields } from "@workspace/contracts"
import { beforeAll, describe, expect, test } from "vitest"
import {
  QUOTE_CHOICE_TYPES,
  QUOTE_FIELD_TYPES,
  quoteFields,
} from "../src/quote-form"
import { fields, layout, site } from "../src/site-config"
import {
  type Built,
  build,
  jsonLdOf,
  ORIGIN,
  type Page,
  ROOT,
  readPages,
} from "./build"
import { FILLED, NO_PROOF } from "./fixture"
import { ALLOWED, validateJsonLd } from "./jsonld"

const REQUIRED_FACTS = [
  "business.name",
  "business.phone",
  "business.email",
  "business.industry",
  "business.offerings",
  "service_area.text",
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
// The quote form's own questions are data too, the file the platform writes
// from the owner's approved list: marked the same way, one question of every
// type, so a word the form's template adds around them is caught as well.
// A form holds eight, so text, number and tel, inputs like email, sit out.
const MARKED_FORM = {
  fields: QUOTE_FIELD_TYPES.filter(
    (type) => !["text", "number", "tel"].includes(type)
  ).map((type, i) => ({
    key: `q_${type}`,
    label: `«q${i}label»`,
    type,
    required: i % 2 === 0,
    hint: `«q${i}hint»`,
    options: QUOTE_CHOICE_TYPES.includes(type)
      ? [`«q${i}a»`, `«q${i}b»`]
      : null,
  })),
}

let filled: Built | undefined
let planted: Built | undefined
let marked: Built | undefined
let reordered: Built | undefined

beforeAll(async () => {
  ;[filled, planted, marked, reordered] = await Promise.all([
    build({ site: FILLED }),
    build({
      site: { ...FILLED, phone: "", email: "" },
      pages: { "planted.astro": PLANTED },
      remove: ["quote.astro", "booking.astro", "about.astro"],
    }),
    build({ site: MARKED, quoteForm: MARKED_FORM }),
    build({
      site: FILLED,
      layout: {
        ...layout,
        home: [
          { kind: "cta_band", variant: "solid" },
          { kind: "hero" },
          { kind: "service_cards", variant: "numbered_rows" },
        ],
      },
    }),
  ])
}, 120_000)
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
  { name: "TrustStrip", selector: "trust-strip", shows: "Fully insured" },
  {
    name: "ServiceCards sections",
    selector: "service-details",
    shows: "Bathrooms cleaned",
  },
  { name: "AreaSection", selector: "area-section", shows: "Oakley" },
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
  {
    name: "Section",
    selector: "section",
    shows:
      "We have cleaned homes in Fairhaven since 2014. We are fully insured, and every cleaner works for us directly rather than through an agency.",
  },
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
    // The home h1 keeps its words whole, its last one in the accent.
    expect(pages.find((p) => p.file === "index.html")?.html).toContain(
      'A home you come back <span class="accent">to</span></h1>'
    )
  })

  test("marks the copy the copy gate reads (packages/gates/src/copy.ts)", () => {
    const html = (file: string) =>
      pagesOf(filled).find((p) => p.file === file)?.html ?? ""
    const home = html("index.html")
    // The subhead is homeIntro; the owner's tagline moves to the about section.
    expect(home).toMatch(
      new RegExp(`data-copy="hero_lede"[^>]*>\\s*${FILLED.homeIntro}`)
    )
    expect(home).toContain(`<p class="hero-note">${FILLED.heroNote}</p>`)
    // The hero's small label is its own field; empty, it is the trade.
    expect(home).toContain(`<p class="eyebrow">${FILLED.heroEyebrow}</p>`)
    expect(home).toContain(FILLED.tagline)
    expect(home).toContain('<span class="accent">Fairhaven homes</span>')
    for (const kind of ["service_body", "step_body", "faq_answer"])
      expect(home, kind).toContain(`data-copy="${kind}"`)
    expect(home).toContain(FILLED.step4Body)
    expect(html("services/weekly-clean/index.html")).toMatch(
      new RegExp(`data-copy="service_detail"[^>]*>\\s*${FILLED.service1Detail}`)
    )
  })

  test("gives each named service its own page, linked, in the sitemap and as a Service", () => {
    const pages = pagesOf(filled)
    const html = (file: string) =>
      pages.find((p) => p.file === file)?.html ?? ""
    const slugs = ["weekly-clean", "deep-clean", "end-of-tenancy"]
    for (const slug of slugs) {
      expect(html(`services/${slug}/index.html`), slug).toContain("<h1")
      // Linked from the home cards and the services page.
      for (const from of ["index.html", "services/index.html"])
        expect(html(from), `${from} ${slug}`).toContain(
          `href="/services/${slug}/"`
        )
    }
    const page = html("services/weekly-clean/index.html")
    expect(page).toContain(`<title>${FILLED.service1Title}</title>`)
    expect(page).toContain(FILLED.service1Description)
    expect(page).toContain(`<h1>${FILLED.service1Heading}</h1>`)
    for (const text of [
      FILLED.service1StepsHeading,
      FILLED.service1FaqHeading,
      FILLED.service1Faq1Answer,
      FILLED.service1CtaHeading,
      FILLED.service1CtaBody,
      "Bathrooms cleaned",
    ])
      expect(page, text).toContain(text)
    // Its questions are its own, never the site's.
    expect(page).not.toContain(FILLED.faq2Answer)
    const ld = jsonLdOf(
      pages.find((p) => p.file === "services/weekly-clean/index.html") as never
    )
    expect(ld.map((t) => t["@type"])).toEqual(["Service", "FAQPage"])
    expect(ld[0]?.url).toBe(`${ORIGIN}/services/weekly-clean/`)
    const sitemap = sitemapUrls(fileOf(filled, "sitemap.xml"))
    for (const slug of slugs)
      expect(sitemap).toContain(`${ORIGIN}/services/${slug}/`)
    // A service page without its own band fields takes the home page's.
    expect(html("services/deep-clean/index.html")).toContain(FILLED.ctaHeading)
    // Each page's own closing band.
    expect(html("about/index.html")).toContain(FILLED.aboutCtaHeading)
    expect(html("about/index.html")).not.toContain(FILLED.ctaHeading)
  })
})

describe("proof", () => {
  let bare: Built | undefined
  let nothing: Built | undefined
  beforeAll(async () => {
    ;[bare, nothing] = await Promise.all([
      build({ site: NO_PROOF }),
      // No proof, no area, no hours, one service: only the quote link is left to say.
      build({
        site: {
          ...NO_PROOF,
          serviceArea: "",
          areaTowns: "",
          weekdayHours: "",
          service2Name: "",
          service3Name: "",
        },
      }),
    ])
  }, 120_000)
  const strip = (built: Built | undefined) =>
    pagesOf(built)
      .find((p) => p.file === "index.html")
      ?.html.match(/<section class="trust-strip[\s\S]*?<\/section>/)?.[0]

  test("shows no figure, review or proof point without the facts behind them", () => {
    const pages = pagesOf(bare)
    expect(hasClass(pages, "testimonials")).toBe(false)
    const texts = visible(pages)
    for (const text of [
      FILLED.statYearsValue,
      FILLED.trust2,
      FILLED.proofHeading,
      FILLED.testimonial1Quote,
    ])
      expect(texts, text).not.toContain(text)
  })

  test("the trust strip falls back to plain facts when there is no proof, and claims nothing", () => {
    const html = strip(bare) ?? ""
    expect(html).toContain(FILLED.serviceArea)
    expect(html).toContain(`Open weekdays ${FILLED.weekdayHours}`)
    expect(html).toContain("Request a quote online")
    expect(html).toMatch(/\d+ services to choose from/)
    expect(html).not.toMatch(/insured|since|years|rated|award|guarantee|free/i)
  })

  test("leaves the trust strip out when fewer than two plain facts exist", () => {
    expect(strip(nothing)).toBeUndefined()
  })

  test("keeps the owner's own proof in place of the fallback", () => {
    const html = pagesOf(filled)
      .find((p) => p.file === "index.html")
      ?.html.match(/<section class="trust-strip[\s\S]*?<\/section>/)?.[0]
    expect(html).toContain(FILLED.trust2)
    expect(html).not.toContain("Request a quote online")
  })

  test("the trust strip shows an icon for every item, four in a row at most", () => {
    const html = strip(filled) ?? ""
    const items = html.match(/<li>/g)?.length ?? 0
    expect(items).toBeGreaterThanOrEqual(2)
    expect(html.match(/class="trust-icon"/g)?.length).toBe(items)
    expect(html).toMatch(/--trust-cols: [2-4]/)
  })

  test("the about record is a paragraph and a list, and no band when the proof is thin", () => {
    const about = (built: Built | undefined) =>
      pagesOf(built).find((p) => p.file === "about/index.html")?.html ?? ""
    const record = about(filled).match(
      /<div class="proof-record">[\s\S]*?<\/ul>/
    )?.[0]
    expect(record).toContain(
      `<p data-copy="proof_body">${FILLED.proofBody}</p>`
    )
    expect(record?.match(/<li>/g)?.length).toBeGreaterThanOrEqual(2)
    expect(about(bare)).not.toContain("proof-record")
  })

  test("shows the owner's proof, as given or rephrased, on the about page", () => {
    const about = pagesOf(filled).find((p) => p.file === "about/index.html")
    expect(about?.texts).toContain(FILLED.proofHeading)
    expect(about?.texts).toContain(FILLED.proofBody)
  })
})

describe("the about page", () => {
  const page = (built: Built | undefined, file: string) => {
    const found = pagesOf(built).find((p) => p.file === file)
    if (!found) throw new Error(`no ${file}`)
    return found
  }

  test("tells the story in the site's voice beside the owner's photo", () => {
    const about = page(filled, "about/index.html")
    for (const text of [
      FILLED.overviewHeading,
      FILLED.overviewBody,
      FILLED.audienceHeading,
      FILLED.audienceBody,
    ])
      expect(about.texts, text).toContain(text)
    for (const text of [FILLED.overview, FILLED.audience])
      expect(about.texts, text).not.toContain(text)
    const photo = about.elements.find((el) =>
      (el.attrs.class ?? "").split(" ").includes("story-photo")
    )
    expect(photo?.attrs.src).toMatch(/^\/_astro\//)
    expect(photo?.attrs.alt).toBe(FILLED.photo1Alt)
  })

  test("says how the work is done, what a visit is like and where, in its own words", () => {
    const about = page(filled, "about/index.html")
    for (const text of [
      FILLED.approachHeading,
      FILLED.approach1Title,
      FILLED.approach3Body,
      FILLED.aboutStepsHeading,
      FILLED.aboutStep2Body,
      FILLED.aboutAreaHeading,
      FILLED.areaBody,
    ])
      expect(about.texts, text).toContain(text)
    // The home page's reasons and steps stay on the home page.
    for (const text of [FILLED.valueProp1Body, FILLED.step1Body])
      expect(about.texts, text).not.toContain(text)
    expect(about.html.match(/data-copy="approach_body"/g)).toHaveLength(3)
    expect(about.html.match(/data-copy="step_body"/g)).toHaveLength(3)
    // The record says each fact once: no trust strip beside it.
    expect(about.html).not.toContain("trust-strip")
  })

  test("the services page helps a visitor choose and asks its own questions", () => {
    const services = page(filled, "services/index.html")
    expect(services.texts).toContain(FILLED.servicesHelpBody)
    expect(services.texts).toContain(FILLED.servicesFaq1Question)
    expect(services.texts).not.toContain(FILLED.faq1Question)
    const faq = services.scripts
      .filter((s) => s.type === "application/ld+json")
      .map((s) => s.body)
      .join("")
    expect(faq).toContain(FILLED.servicesFaq1Question)
    expect(faq).not.toContain(FILLED.faq1Question)
  })

  test("the contact page says what to send and links the form; the quote page says where details go", () => {
    const contact = page(filled, "contact/index.html")
    expect(contact.texts).toContain(FILLED.contactIncludeBody)
    expect(contact.elements.map((el) => el.attrs.href)).toContain("/quote/")
    expect(page(filled, "quote/index.html").texts).toContain(
      FILLED.quotePrivacy
    )
  })

  test("without one, the home page says who the business serves and links nowhere", () => {
    const hrefs = pagesOf(planted).flatMap((p) =>
      p.elements.map((el) => el.attrs.href ?? "")
    )
    expect(hrefs).not.toContain("/about/")
    expect(page(planted, "index.html").texts).toContain(FILLED.audienceBody)
    expect(page(filled, "index.html").texts).not.toContain(FILLED.audienceBody)
  })
})

describe("the quote form", () => {
  const page = () => {
    const found = pagesOf(filled).find((p) => p.file === "quote/index.html")
    if (!found) throw new Error("no quote page")
    return found
  }

  test("asks for the contact details, then every question in quote-form.json", () => {
    const { elements, texts } = page()
    const expected = [
      {
        id: "quote-name",
        name: "name",
        label: FILLED.quoteNameLabel,
        required: true,
        hint: null,
      },
      {
        id: "quote-email",
        name: "email",
        label: FILLED.quoteEmailLabel,
        required: true,
        hint: null,
      },
      {
        id: "quote-phone",
        name: "phone",
        label: FILLED.quotePhoneLabel,
        required: false,
        hint: null,
      },
      ...quoteFields.map((field) => ({
        id: `quote-q-${field.key}`,
        name: field.key,
        label: field.label,
        required: field.required,
        hint: field.hint,
      })),
    ]
    for (const field of expected) {
      const control = elements.find((el) => el.attrs.id === field.id)
      expect(control, field.id).toBeDefined()
      expect(control?.attrs.name, field.id).toBe(field.name)
      expect("required" in (control?.attrs ?? {}), field.id).toBe(
        field.required
      )
      expect(
        elements.some((el) => el.tag === "label" && el.attrs.for === field.id),
        field.id
      ).toBe(true)
      expect(texts, field.id).toContain(field.label)
      if (field.hint) {
        expect(control?.attrs["aria-describedby"], field.id).toBe(
          `${field.id}-hint`
        )
        expect(texts, field.id).toContain(field.hint)
      }
    }
    expect(texts).toContain(FILLED.quoteContactLegend)
    expect(texts).toContain(FILLED.quoteRequestLegend)
  })

  test("sends by email until there is an endpoint", () => {
    const form = page().elements.find((el) => el.tag === "form")
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

describe("the pages' sections as data", () => {
  test("render in the order layout gives, and a dropped kind is gone", () => {
    const home = pagesOf(reordered).find((page) => page.file === "index.html")
    const classes = [
      ...(home?.html.matchAll(/<section class="([^"]*)"/g) ?? []),
    ].map((match) => String(match[1]))
    // The CTA band, the hero, then the services; no trust strip, no steps.
    expect(classes).toHaveLength(3)
    expect(classes[0]).toContain("cta-band")
    expect(classes[1]).toContain("hero")
    expect(classes[2]).toContain("services-numbered_rows")
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
      new Set(["WebSite", "LocalBusiness", "FAQPage", "Service"])
    )
    for (const { value } of items) {
      expect(ALLOWED).toContain(value["@type"])
      expect(value.name ?? value.mainEntity).toBeTruthy()
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
    for (const path of ["/quote/", "/booking/", "/about/"]) {
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
        // A card's ordinal (01, 02) is design rule 7's numbering, not copy.
        .filter((rest) => !/^\s*\d{2}\s*$/.test(rest))
        .map((rest) => `${page.file}: "${rest.trim()}"`)
    )
    expect(inline).toEqual([])
  })

  test("every page renders with no JavaScript", () => {
    for (const built of [filled, planted, marked]) {
      if (!built) throw new Error("the build did not run")
      const pages = readPages(built.dist)
      // The one inline script is the entrance reveal (Base.astro): it marks
      // blocks only once it runs, so without it nothing is hidden.
      const scripts = pages.flatMap((page) =>
        page.scripts
          .filter((script) => script.type !== "application/ld+json")
          .filter((script) => !script.body.includes("dataset.reveal"))
          .map(() => page.file)
      )
      const hiddenWithoutScript = pages
        .filter((page) => /class="[^"]*\breveal\b|data-reveal/.test(page.html))
        .map((page) => page.file)
      expect(hiddenWithoutScript).toEqual([])
      const bundles = readdirSync(built.dist, { recursive: true })
        .map(String)
        .filter((file) => /\.m?js$/.test(file))
      expect(scripts).toEqual([])
      expect(bundles).toEqual([])
    }
  })
})
