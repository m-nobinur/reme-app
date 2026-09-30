import { site } from "./site-config"

/**
 * The JSON-LD the starter emits. Only LocalBusiness and WebSite, a subset of
 * the types the platform's structured-data gate allows, and each needs a
 * name, so a type whose name field is empty is not emitted at all. Every
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
      areaServed: site.areaServed,
    }),
  ]
}
