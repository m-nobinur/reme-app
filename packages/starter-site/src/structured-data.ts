import { site } from "./site-config"

/**
 * The JSON-LD the starter emits. Only LocalBusiness, WebSite, Service and
 * FAQPage, a subset of the types the platform's structured-data gate allows,
 * and each needs a name (FAQPage its questions), so one whose name field is
 * empty is not emitted at all. Every
 * property comes from a site field and is left out when that field is empty:
 * no telephone, email, openingHours or areaServed without its fact. No
 * priceRange: the site quotes on request and states no price.
 */
type Thing = Record<string, unknown>

const present = (entries: Thing): Thing =>
  Object.fromEntries(
    Object.entries(entries).filter(
      ([, value]) => value !== "" && value !== undefined
    )
  )

export function webSite(origin: URL | undefined): Thing[] {
  if (!site.businessName) return []
  return [
    present({ "@type": "WebSite", name: site.businessName, url: origin?.href }),
  ]
}

export function localBusiness(origin: URL | undefined): Thing[] {
  if (!site.businessName) return []
  return [
    present({
      "@type": "LocalBusiness",
      name: site.businessName,
      url: origin?.href,
      telephone: site.phone,
      email: site.email,
      openingHours: site.openingHours,
      areaServed: site.areaServed || site.serviceAreaText,
    }),
  ]
}

/** The questions the Faq section shows: an entry needs both halves. */
export const faqItems = ([1, 2, 3, 4, 5, 6, 7, 8] as const)
  .map((n) => ({
    question: site[`faq${n}Question`],
    answer: site[`faq${n}Answer`],
  }))
  .filter((item) => item.question && item.answer)

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

/** A service name as its page's path segment: "End of tenancy" is "end-of-tenancy". */
export const slugOf = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

/**
 * The services the cards, the hero, the services page and each service's
 * own page show, numbered so a card can link to its page. An entry needs a
 * name or a body; its page needs a name, and two names that make one slug
 * keep the first's and number the second's.
 */
export const serviceItems = ([1, 2, 3, 4, 5, 6] as const)
  .map((n) => ({
    id: `service-${n}`,
    n,
    name: site[`service${n}Name`],
    body: site[`service${n}Body`],
    detail: site[`service${n}Detail`],
    heading: site[`service${n}Heading`],
    title: site[`service${n}Title`],
    description: site[`service${n}Description`],
    stepsHeading: site[`service${n}StepsHeading`],
    faqHeading: site[`service${n}FaqHeading`],
    faqs: ([1, 2, 3, 4] as const)
      .map((m) => ({
        question: site[`service${n}Faq${m}Question`],
        answer: site[`service${n}Faq${m}Answer`],
      }))
      .filter((item) => item.question && item.answer),
    ctaHeading: site[`service${n}CtaHeading`],
    ctaBody: site[`service${n}CtaBody`],
    icon: site[`service${n}Icon`],
    includes: lines(site[`service${n}Includes`]),
    for: site[`service${n}For`],
    image: {
      src: site[`service${n}Image`],
      alt: site[`service${n}ImageAlt`],
    },
  }))
  .filter((item) => item.name || item.body)
  .map((item, i, all) => {
    const base = slugOf(item.name) || item.id
    const taken = all.slice(0, i).some((o) => (slugOf(o.name) || o.id) === base)
    return { ...item, slug: taken ? `${base}-${item.n}` : base }
  })

export type ServiceItem = (typeof serviceItems)[number]

/** The services that get a page of their own: those with a name. */
export const servicePages = serviceItems.filter((item) => item.name)

/** Each named service as a Service the business provides. */
export function services(
  origin: URL | undefined,
  items: readonly ServiceItem[] = servicePages
): Thing[] {
  if (!site.businessName) return []
  return items
    .filter((item) => item.name)
    .map((item) =>
      present({
        "@type": "Service",
        name: item.name,
        description: item.detail || item.body,
        url: origin ? new URL(`/services/${item.slug}/`, origin).href : "",
        provider: { "@type": "LocalBusiness", name: site.businessName },
        areaServed: site.areaServed || site.serviceAreaText,
      })
    )
}

/** The same questions as FAQPage, so the markup and the page cannot differ. */
export function faqPage(items: typeof faqItems = faqItems): Thing[] {
  if (items.length === 0) return []
  return [
    {
      "@type": "FAQPage",
      mainEntity: items.map((item) => ({
        "@type": "Question",
        name: item.question,
        acceptedAnswer: { "@type": "Answer", text: item.answer },
      })),
    },
  ]
}
