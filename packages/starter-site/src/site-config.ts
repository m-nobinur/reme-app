/**
 * Every string the site shows comes from here, and `fields` says what each
 * one needs. This file imports nothing, so it builds anywhere the site does.
 *
 * A `fact` field holds the rendered form of one canonical fact. It ships
 * empty, and an empty field renders nothing: the page leaves that part out
 * rather than showing a placeholder, and the Developer asks for the fact
 * instead of inventing one. A `composed` field is text the Developer may
 * write or keep, whose claims must trace to facts; the labels below make no
 * claim at all.
 *
 * `fields` is read in declaration order when asking for missing facts, so the
 * required facts come first. Its keys are exactly the keys of `site`, which
 * the type below enforces and the starter's tests check against the
 * `SiteField` contract.
 */
type Field =
  | { kind: "fact"; fact_key: string; required: boolean }
  | { kind: "composed" }

const values = {
  /** business.name, as given. */
  businessName: "",
  /** business.phone, the E.164 number as given. */
  phone: "",
  /** business.email, the address as given. */
  email: "",
  /** hours.weekday, as "08:00 to 17:00". */
  weekdayHours: "",
  /** service_area.radius, as "Within 25 km of Fairhaven". */
  serviceArea: "",
  /** pricing.standard_clean_hourly, as "$35.00 an hour". */
  standardCleanHourly: "",
  /** hours.weekday for structured data, as "Mo-Fr 08:00-17:00". */
  openingHours: "",
  /** service_area.radius for structured data: the centre, as "Fairhaven". */
  areaServed: "",
  standardCleanName: "Standard clean",
  tagline: "",
  homeIntro: "",
  servicesIntro: "",
  serviceAreaIntro: "",
  contactIntro: "",
  quoteIntro: "",
  bookingIntro: "",
  skipLink: "Skip to content",
  primaryNavLabel: "Main",
  navHome: "Home",
  navServices: "Services",
  navServiceArea: "Service area",
  navContact: "Contact",
  navQuote: "Get a quote",
  navBooking: "Book a clean",
  servicesHeading: "Services",
  serviceAreaHeading: "Service area",
  contactHeading: "Contact",
  quoteHeading: "Get a quote",
  bookingHeading: "Book a clean",
  priceHeading: "Prices",
  phoneLabel: "Phone",
  emailLabel: "Email",
  weekdayHoursLabel: "Weekdays",
  notFoundHeading: "Page not found",
  notFoundBody: "The page you asked for is not here.",
  homeLink: "Go to the home page",
}

/** Typed as strings, not literals: the Developer changes these values. */
export const site: Record<keyof typeof values, string> = values

const composed: Field = { kind: "composed" }

export const fields: Record<keyof typeof site, Field> = {
  businessName: { kind: "fact", fact_key: "business.name", required: true },
  phone: { kind: "fact", fact_key: "business.phone", required: true },
  email: { kind: "fact", fact_key: "business.email", required: true },
  weekdayHours: { kind: "fact", fact_key: "hours.weekday", required: true },
  serviceArea: {
    kind: "fact",
    fact_key: "service_area.radius",
    required: true,
  },
  standardCleanHourly: {
    kind: "fact",
    fact_key: "pricing.standard_clean_hourly",
    required: true,
  },
  openingHours: { kind: "fact", fact_key: "hours.weekday", required: false },
  areaServed: {
    kind: "fact",
    fact_key: "service_area.radius",
    required: false,
  },
  standardCleanName: composed,
  tagline: composed,
  homeIntro: composed,
  servicesIntro: composed,
  serviceAreaIntro: composed,
  contactIntro: composed,
  quoteIntro: composed,
  bookingIntro: composed,
  skipLink: composed,
  primaryNavLabel: composed,
  navHome: composed,
  navServices: composed,
  navServiceArea: composed,
  navContact: composed,
  navQuote: composed,
  navBooking: composed,
  servicesHeading: composed,
  serviceAreaHeading: composed,
  contactHeading: composed,
  quoteHeading: composed,
  bookingHeading: composed,
  priceHeading: composed,
  phoneLabel: composed,
  emailLabel: composed,
  weekdayHoursLabel: composed,
  notFoundHeading: composed,
  notFoundBody: composed,
  homeLink: composed,
}
