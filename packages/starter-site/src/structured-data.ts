import { faqsOf, pageDocument } from "./documents"
import { iconFor } from "./icons"
import { servicesOf } from "./page-seed"
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

/** The home page's questions, for a Faq given none of its own. */
export const faqItems = faqsOf(pageDocument("home"))

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

/** The icons the owner's services name, so a picked one is not a repeat. */
const taken = new Set<string>(
  ([1, 2, 3, 4, 5, 6] as const).map((n) => site[`service${n}Icon`])
)

const of = (n: number, field: string) =>
  site[`service${n}${field}` as keyof typeof site]

/**
 * The services the cards, the hero, the services page and each service's
 * own page show, numbered so a card can link to its page. An entry needs a
 * name or a body; its page needs a name, and its page's words are in its
 * document, src/content/pages/services/<slug>.json.
 */
export const serviceItems = servicesOf(site)
  .map((item) => ({
    ...item,
    detail: of(item.n, "Detail"),
    icon: of(item.n, "Icon"),
    includes: lines(of(item.n, "Includes")),
    for: of(item.n, "For"),
    image: { src: of(item.n, "Image"), alt: of(item.n, "ImageAlt") },
    headerImage: {
      src: of(item.n, "HeaderImage"),
      alt: of(item.n, "HeaderImageAlt"),
    },
  }))
  // An empty or unknown icon takes one from the service's own words, and no
  // service takes one another already shows.
  .map((item) => {
    const icon = iconFor(
      item.icon,
      `${item.name} ${item.body}`,
      "sparkle",
      taken
    )
    taken.add(icon)
    return { ...item, icon }
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
export function faqPage(items: typeof faqItems): Thing[] {
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
