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
 * `required` is about asking, never about rendering (ADR-033): the Developer
 * asks for a required fact that is missing, and a field the owner asked to
 * keep off the site stays empty.
 *
 * Numbered fields are one list each, filled from 1 upwards. A list entry
 * renders only when its own fields are set, and a section whose entries are
 * all empty renders nothing at all, heading included.
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
  /** testimonials.quote_1, the review's own words, unedited. */
  testimonial1Quote: "",
  /** testimonials.author_1, the reviewer's name as the review gives it. */
  testimonial1Author: "",
  /** testimonials.quote_2, the review's own words, unedited. */
  testimonial2Quote: "",
  /** testimonials.author_2, the reviewer's name as the review gives it. */
  testimonial2Author: "",
  /** about.years_in_business, the number on its own, as "12". */
  statYearsValue: "",
  /** about.clients_served, the number on its own, as "400". */
  statClientsValue: "",
  /** reviews.average_rating, as "4.8". */
  statRatingValue: "",
  /** media.photo_1, a path the site already holds, as "/photos/kitchen.jpg". */
  photo1Src: "",
  /** media.photo_1_alt, what that photo shows, in one sentence. */
  photo1Alt: "",
  /** media.photo_2, a path the site already holds. */
  photo2Src: "",
  /** media.photo_2_alt, what that photo shows, in one sentence. */
  photo2Alt: "",
  /** media.photo_3, a path the site already holds. */
  photo3Src: "",
  /** media.photo_3_alt, what that photo shows, in one sentence. */
  photo3Alt: "",
  /** The home page's h1: a short slogan. Falls back to the business name. */
  heroHeading: "",
  tagline: "",
  standardCleanName: "Standard clean",
  homeIntro: "",
  servicesIntro: "",
  serviceAreaIntro: "",
  contactIntro: "",
  quoteIntro: "",
  bookingIntro: "",
  valuePropsHeading: "Why choose us",
  valueProp1Title: "",
  valueProp1Body: "",
  valueProp2Title: "",
  valueProp2Body: "",
  valueProp3Title: "",
  valueProp3Body: "",
  serviceCardsHeading: "What we do",
  service1Name: "",
  service1Body: "",
  service2Name: "",
  service2Body: "",
  service3Name: "",
  service3Body: "",
  stepsHeading: "How it works",
  step1Title: "",
  step1Body: "",
  step2Title: "",
  step2Body: "",
  step3Title: "",
  step3Body: "",
  statYearsLabel: "Years in business",
  statClientsLabel: "Clients served",
  statRatingLabel: "Average rating",
  testimonialsHeading: "What clients say",
  galleryHeading: "Our work",
  faqHeading: "Common questions",
  faq1Question: "",
  faq1Answer: "",
  faq2Question: "",
  faq2Answer: "",
  faq3Question: "",
  faq3Answer: "",
  ctaHeading: "",
  ctaBody: "",
  ctaLabel: "Get in touch",
  skipLink: "Skip to content",
  primaryNavLabel: "Main",
  footerNavLabel: "Footer",
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
  testimonial1Quote: {
    kind: "fact",
    fact_key: "testimonials.quote_1",
    required: false,
  },
  testimonial1Author: {
    kind: "fact",
    fact_key: "testimonials.author_1",
    required: false,
  },
  testimonial2Quote: {
    kind: "fact",
    fact_key: "testimonials.quote_2",
    required: false,
  },
  testimonial2Author: {
    kind: "fact",
    fact_key: "testimonials.author_2",
    required: false,
  },
  statYearsValue: {
    kind: "fact",
    fact_key: "about.years_in_business",
    required: false,
  },
  statClientsValue: {
    kind: "fact",
    fact_key: "about.clients_served",
    required: false,
  },
  statRatingValue: {
    kind: "fact",
    fact_key: "reviews.average_rating",
    required: false,
  },
  photo1Src: { kind: "fact", fact_key: "media.photo_1", required: false },
  photo1Alt: { kind: "fact", fact_key: "media.photo_1_alt", required: false },
  photo2Src: { kind: "fact", fact_key: "media.photo_2", required: false },
  photo2Alt: { kind: "fact", fact_key: "media.photo_2_alt", required: false },
  photo3Src: { kind: "fact", fact_key: "media.photo_3", required: false },
  photo3Alt: { kind: "fact", fact_key: "media.photo_3_alt", required: false },
  heroHeading: composed,
  tagline: composed,
  standardCleanName: composed,
  homeIntro: composed,
  servicesIntro: composed,
  serviceAreaIntro: composed,
  contactIntro: composed,
  quoteIntro: composed,
  bookingIntro: composed,
  valuePropsHeading: composed,
  valueProp1Title: composed,
  valueProp1Body: composed,
  valueProp2Title: composed,
  valueProp2Body: composed,
  valueProp3Title: composed,
  valueProp3Body: composed,
  serviceCardsHeading: composed,
  service1Name: composed,
  service1Body: composed,
  service2Name: composed,
  service2Body: composed,
  service3Name: composed,
  service3Body: composed,
  stepsHeading: composed,
  step1Title: composed,
  step1Body: composed,
  step2Title: composed,
  step2Body: composed,
  step3Title: composed,
  step3Body: composed,
  statYearsLabel: composed,
  statClientsLabel: composed,
  statRatingLabel: composed,
  testimonialsHeading: composed,
  galleryHeading: composed,
  faqHeading: composed,
  faq1Question: composed,
  faq1Answer: composed,
  faq2Question: composed,
  faq2Answer: composed,
  faq3Question: composed,
  faq3Answer: composed,
  ctaHeading: composed,
  ctaBody: composed,
  ctaLabel: composed,
  skipLink: composed,
  primaryNavLabel: composed,
  footerNavLabel: composed,
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
