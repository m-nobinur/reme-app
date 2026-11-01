import { plain } from "./accent"
import type { Block, PageDocument, PageSection } from "./page-document"
import { layout as DEFAULT_LAYOUT, pageFields } from "./page-fields"

/**
 * Each page's document as src/site-config.ts's page fields and `layout` say
 * it, with every fallback the starter applied to them resolved: the seed a
 * site's documents are written from once, on its first build after the
 * starter took documents, and what a page with no document shows until then.
 * Pure over the values, so the orchestrator writes the same documents from
 * the config's text that the build would render.
 */

type Values = Readonly<Record<string, string>>
type Planned = { kind: string; variant?: string }
export type Layout = Readonly<Record<string, readonly Planned[]>>

/** The pages with a document of their own; a service's is `services/<slug>`. */
export const PAGES = [
  "home",
  "about",
  "services",
  "service_area",
  "contact",
  "quote",
] as const
export type Page = (typeof PAGES)[number] | "service"

/** A service name as its page's path segment: "End of tenancy" is "end-of-tenancy". */
export const slugOf = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

/**
 * The services by number, as the cards number them: an entry needs a name or
 * a body, and two names that make one slug keep the first's and number the
 * second's.
 */
export function servicesOf(values: Values) {
  const found = [1, 2, 3, 4, 5, 6]
    .map((n) => ({
      n,
      id: `service-${n}`,
      name: values[`service${n}Name`] ?? "",
      body: values[`service${n}Body`] ?? "",
    }))
    .filter((item) => item.name || item.body)
  return found.map((item, i) => {
    const base = slugOf(item.name) || item.id
    const used = found
      .slice(0, i)
      .some((o) => (slugOf(o.name) || o.id) === base)
    return { ...item, slug: used ? `${base}-${item.n}` : base }
  })
}

/** Where each page's document lives under src/content/pages/. */
export const documentPath = (page: Page, slug?: string) =>
  page === "service"
    ? `services/${slug}.json`
    : `${page.replace("_", "-")}.json`

/** Each section's id on its page: its kind, hyphenated, numbered from 2 when it repeats. */
export function sectionIds(kinds: readonly string[]): string[] {
  const ids: string[] = []
  for (const kind of kinds) {
    const base = kind.replace(/_/g, "-")
    let id = base
    for (let n = 2; ids.includes(id); n++) id = `${base}-${n}`
    ids.push(id)
  }
  return ids
}

const numbered = <T>(count: number, entry: (n: number) => T) =>
  Array.from({ length: count }, (_, i) => entry(i + 1))

export function seedDocuments(
  v: Values,
  layout: Layout = DEFAULT_LAYOUT,
  /** Whether the site has an about page, which the home about section defers to. */
  hasAbout: boolean
): Record<string, PageDocument> {
  const get = (name: string) =>
    v[name] ?? (pageFields as Record<string, string>)[name] ?? ""
  const faqs = (prefix: string, count: number) =>
    numbered(count, (n) => ({
      question: get(`${prefix}${n}Question`),
      answer: get(`${prefix}${n}Answer`),
    })).filter((item) => item.question && item.answer)
  const steps = (prefix: string) =>
    numbered(4, (n) => ({
      title: get(`${prefix}${n}Title`),
      body: get(`${prefix}${n}Body`),
    })).filter((item) => item.title || item.body)

  const homeFaqs = faqs("faq", 8)
  const ownServicesFaqs = faqs("servicesFaq", 4)
  const servicesFaqs =
    ownServicesFaqs.length > 0 ||
    (layout.home ?? []).some((s) => s.kind === "faq")
      ? ownServicesFaqs
      : homeFaqs

  type Service = ReturnType<typeof servicesOf>[number]
  const seedPage = (page: Page, service?: Service): PageDocument => {
    const s = (field: string) =>
      service ? get(`service${service.n}${field}`) : ""
    const home = page === "home"
    const about = page === "about"
    const HEAD: Record<Page, [string, string]> = {
      home: [
        get("heroHeading") || get("businessName"),
        get("homeIntro") || get("tagline"),
      ],
      about: [get("aboutHeading"), get("aboutIntro")],
      services: [get("servicesHeading"), get("servicesIntro")],
      service_area: [get("serviceAreaHeading"), get("serviceAreaIntro")],
      contact: [get("contactHeading"), get("contactIntro")],
      quote: [get("quoteHeading"), get("quoteIntro")],
      service: [s("Heading") || (service?.name ?? ""), service?.body ?? ""],
    }
    const CTA: Record<Page, [string, string]> = {
      home: [get("ctaHeading"), get("ctaBody")],
      about: [get("aboutCtaHeading"), get("aboutCtaBody")],
      services: [get("servicesCtaHeading"), get("servicesCtaBody")],
      service_area: [get("serviceAreaCtaHeading"), get("serviceAreaCtaBody")],
      contact: [get("contactCtaHeading"), get("contactCtaBody")],
      quote: ["", ""],
      service: [s("CtaHeading"), s("CtaBody")],
    }
    const META: Record<Page, [string, string]> = {
      home: [
        get("homeTitle") || get("businessName"),
        get("homeDescription") || get("tagline") || get("homeIntro"),
      ],
      about: [get("aboutTitle"), get("aboutDescription")],
      services: [get("servicesTitle"), get("servicesDescription")],
      service_area: [get("serviceAreaTitle"), get("serviceAreaDescription")],
      contact: [get("contactTitle"), get("contactDescription")],
      quote: [get("quoteTitle"), get("quoteDescription")],
      service: [s("Title"), s("Description")],
    }
    const [heading, lede] = HEAD[page]
    const [title, description] = META[page]

    const planned = [...(layout[page] ?? [])]
    // A service page always shows its service's detail, whatever the plan laid
    // out: the copy gate fails one without what is included and who it suits.
    if (page === "service" && !planned.some((p) => p.kind === "service_cards"))
      planned.splice(planned.findIndex((p) => p.kind === "hero") + 1, 0, {
        kind: "service_cards",
      })

    const ids = sectionIds(planned.map((p) => p.kind))
    const sections = planned.map((p, i): PageSection => {
      const id = ids[i] as string
      const own = (what: string) => `${id}-${what}`
      const section = {
        id,
        kind: p.kind,
        ...(p.variant ? { variant: p.variant } : {}),
      } as PageSection
      const words = (w: {
        eyebrow?: string
        heading?: string
        intro?: string
        blocks?: (Block | false | "")[]
      }) =>
        ({
          ...section,
          ...w,
          blocks: (w.blocks ?? []).filter((b): b is Block => Boolean(b)),
        }) as PageSection
      const prose = (
        what: string,
        markdown: string,
        provenance: Block["provenance"],
        extra: { eyebrow?: string; heading?: string } = {}
      ): Block => ({
        id: own(what),
        type: "prose",
        provenance,
        ...extra,
        markdown,
      })
      switch (p.kind) {
        case "hero":
          return words({
            eyebrow: home ? get("heroEyebrow") : "",
            heading,
            intro: lede,
            blocks: [
              home &&
                get("heroNote") && {
                  id: own("note"),
                  type: "callout",
                  provenance: "facts",
                  text: get("heroNote"),
                },
            ],
          })
        case "service_cards":
          return words({
            eyebrow: get("serviceCardsEyebrow"),
            heading: get("serviceCardsHeading"),
            blocks: [
              page === "services" &&
                get("servicesHelpBody") &&
                prose("help", get("servicesHelpBody"), "facts", {
                  eyebrow: get("servicesHelpEyebrow"),
                  heading: get("servicesHelpHeading"),
                }),
            ],
          })
        case "value_props":
          return words({
            eyebrow: get(about ? "approachEyebrow" : "valuePropsEyebrow"),
            heading: get(about ? "approachHeading" : "valuePropsHeading"),
            blocks: [
              {
                id: own("cards"),
                type: "cards",
                provenance: "facts",
                items: numbered(about ? 4 : 3, (n) => {
                  const at = `${about ? "approach" : "valueProp"}${n}`
                  return {
                    title: get(`${at}Title`),
                    body: get(`${at}Body`),
                    icon: get(`${at}Icon`),
                  }
                }).filter((item) => item.title || item.body),
              },
            ],
          })
        case "steps": {
          const ownSteps = about
            ? steps("aboutStep")
            : service
              ? steps(`service${service.n}Step`)
              : []
          return words({
            eyebrow: get("stepsEyebrow"),
            heading:
              (about ? get("aboutStepsHeading") : s("StepsHeading")) ||
              get("stepsHeading"),
            blocks: [
              {
                id: own("list"),
                type: "steps",
                provenance: "facts",
                items: about || ownSteps.length > 0 ? ownSteps : steps("step"),
              },
            ],
          })
        }
        case "about": {
          if (home) {
            const [summary, summaryFrom] = get("aboutIntro")
              ? [get("aboutIntro"), "facts" as const]
              : get("overviewBody")
                ? [get("overviewBody"), "facts" as const]
                : [get("overview"), "owner" as const]
            const audience =
              !hasAbout && (get("audienceBody") || get("audience"))
            return words({
              eyebrow: get("aboutEyebrow"),
              heading: get("homeAboutHeading") || get("aboutHeading"),
              intro:
                (summary || audience) && get("homeIntro") ? get("tagline") : "",
              blocks: [
                summary && prose("summary", summary, summaryFrom),
                audience &&
                  prose(
                    "audience",
                    audience,
                    get("audienceBody") ? "facts" : "owner"
                  ),
              ],
            })
          }
          const story = get("overviewBody") || get("overview")
          const audience = get("audienceBody") || get("audience")
          return words({
            eyebrow: get("overviewEyebrow"),
            heading: story ? get("overviewHeading") : get("audienceHeading"),
            intro: story,
            blocks: [
              audience &&
                prose(
                  "audience",
                  audience,
                  get("audienceBody") ? "facts" : "owner",
                  {
                    heading: story ? get("audienceHeading") : "",
                  }
                ),
              prose(
                "record",
                get("proofBody") || get("proof"),
                get("proofBody") ? "facts" : "owner",
                { eyebrow: get("proofEyebrow"), heading: get("proofHeading") }
              ),
            ],
          })
        }
        case "testimonials":
          return words({
            eyebrow: get("testimonialsEyebrow"),
            heading: get("testimonialsHeading"),
          })
        case "gallery":
          return words({
            eyebrow: get("galleryEyebrow"),
            heading: get("galleryHeading"),
          })
        case "service_area":
          return words({
            eyebrow: get("areaEyebrow"),
            heading: home
              ? get("homeAreaHeading") || get("serviceAreaHeading")
              : about
                ? get("aboutAreaHeading")
                : "",
            intro: get("areaBody"),
          })
        case "faq":
          return words({
            eyebrow: get("faqEyebrow"),
            heading:
              (page === "services"
                ? get("servicesFaqHeading")
                : s("FaqHeading")) || get("faqHeading"),
            intro: get("faqIntro"),
            blocks: [
              {
                id: own("questions"),
                type: "faq",
                provenance: "facts",
                items:
                  page === "services"
                    ? servicesFaqs
                    : service
                      ? faqs(`service${service.n}Faq`, 4)
                      : homeFaqs,
              },
            ],
          })
        case "cta_band": {
          const [ctaHeading, ctaBody] = CTA[page]
          return words({
            eyebrow: get("ctaEyebrow"),
            blocks: [
              {
                id: own("action"),
                type: "cta",
                provenance: "facts",
                heading: ctaHeading || get("ctaHeading"),
                body: ctaBody || get("ctaBody"),
              },
            ],
          })
        }
        case "contact":
          return words({
            blocks: [
              get("contactIncludeBody") &&
                prose("note", get("contactIncludeBody"), "facts", {
                  eyebrow: get("contactIncludeEyebrow"),
                  heading: get("contactIncludeHeading"),
                }),
            ],
          })
        case "quote_form": {
          const next = numbered(3, (n) => get(`quoteNext${n}`)).filter(Boolean)
          return words({
            eyebrow: get("quoteEyebrow"),
            heading: get("quoteAsideHeading"),
            blocks: [
              next.length > 0 && {
                id: own("next"),
                type: "checklist",
                provenance: "facts",
                items: next,
              },
            ],
          })
        }
        default:
          return section
      }
    })
    return {
      page,
      ...(service ? { slug: service.slug } : {}),
      title: title || (home ? "" : plain(heading)),
      description: description || lede,
      sections,
    } as PageDocument
  }

  const docs: Record<string, PageDocument> = {}
  for (const page of PAGES) docs[documentPath(page)] = seedPage(page)
  for (const service of servicesOf(v).filter((item) => item.name))
    docs[documentPath("service", service.slug)] = seedPage("service", service)
  return docs
}

const WORDS = ["eyebrow", "heading", "intro", "blocks"] as const

/**
 * A document with the seed filled in where it gives nothing: a section with
 * none of eyebrow, heading, intro and blocks takes the words of the seed's
 * section of the same id, and an empty title or description the seed's. So
 * a page can be re-ordered, or take a custom section, before its words move
 * out of src/site-config.ts.
 */
export function withSeed(
  doc: PageDocument,
  seeded?: PageDocument
): PageDocument {
  return {
    ...doc,
    title: doc.title || seeded?.title || "",
    description: doc.description || seeded?.description || "",
    sections: doc.sections.map((section) => {
      if (WORDS.some((key) => key in section)) return section
      const from = seeded?.sections.find((s) => s.id === section.id)
      return from
        ? {
            ...section,
            ...Object.fromEntries(
              WORDS.filter((key) => key in from).map((key) => [key, from[key]])
            ),
          }
        : section
    }),
  }
}
