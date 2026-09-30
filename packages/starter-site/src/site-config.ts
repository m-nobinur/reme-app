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
  /** business.industry, its name, as "Limousine and chauffeur hire". */
  industry: "",
  /** business.offerings, one item to a line, as given. */
  offerings: "",
  /** service_area.text, as given, as "Fairhaven and the villages around it". */
  serviceAreaText: "",
  /** hours.weekday, as "08:00 to 17:00". Optional: no hours, no hours row. */
  weekdayHours: "",
  /** service_area.radius, as "Within 25 km of Fairhaven". */
  serviceArea: "",
  /** business.tagline, the owner's one line, as given. */
  tagline: "",
  /** business.audience, who the business serves, as given. */
  audience: "",
  /** business.overview, how the business works, as given. */
  overview: "",
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
  /**
   * The colour the owner chose, as #rrggbb: their palette's brand colour
   * (site.palette) or one they named. Empty is the default theme, and so is
   * anything that is not a hex colour. Do not pick one for them.
   */
  brandColor: "",
  /**
   * The layout the owner chose (site.template): classic, modern or bold.
   * Anything else reads as classic.
   */
  template: "classic",
  /**
   * The type the owner chose (site.font): clean_sans, classic_serif or
   * soft_rounded. Empty or anything else keeps the default pairing.
   */
  font: "",
  /** media.uploads, the path of the owner's logo, as "/uploads/<id>.png". Empty shows the business name as text. */
  logo: "",
  /** The logo's alt text: the business name as the logo shows it. */
  logoAlt: "",
  /**
   * media.uploads, the path of the owner's photo the home page's hero shows,
   * as "/uploads/<id>.jpg". Empty keeps the hero's drawn panel.
   */
  heroImage: "",
  /** What that photo shows, in one sentence: its alt text. The hero shows the photo only with it. */
  heroImageAlt: "",
  /** The home page's h1: a short slogan. Falls back to the business name. */
  heroHeading: "",
  homeIntro: "",
  servicesIntro: "",
  serviceAreaIntro: "",
  contactIntro: "",
  quoteIntro: "",
  /**
   * Where the quote form sends a request, once an endpoint exists. Empty
   * sends it by email to site.email instead; with neither, no form renders.
   */
  quoteFormAction: "",
  /** The subject line of a request sent by email. */
  quoteEmailSubject: "Quote request",
  bookingIntro: "",
  aboutHeading: "About us",
  audienceHeading: "Who we work with",
  offeringsHeading: "Everything we offer",
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
  /** The band's button text. Empty uses the label of the page it links to. */
  ctaLabel: "",
  skipLink: "Skip to content",
  primaryNavLabel: "Main",
  footerNavLabel: "Footer",
  navHome: "Home",
  navServices: "Services",
  navServiceArea: "Service area",
  navContact: "Contact",
  navQuote: "Request a quote",
  navBooking: "Book",
  servicesHeading: "Services",
  serviceAreaHeading: "Service area",
  contactHeading: "Contact",
  quoteHeading: "Request a quote",
  bookingHeading: "Make a booking",
  quoteContactLegend: "Your details",
  quoteRequestLegend: "Your request",
  quoteNameLabel: "Your name",
  quoteEmailLabel: "Email address",
  quotePhoneLabel: "Phone number",
  quoteServiceLabel: "What you need",
  quoteLocationLabel: "Location",
  quoteLocationHint: "A town, postcode or address",
  quoteDateLabel: "Preferred date",
  quoteDetailsLabel: "Details",
  quoteDetailsHint: "Anything that helps us understand the request",
  quoteSourceLabel: "How did you hear about us?",
  quoteChoose: "Choose one",
  quoteOptional: "optional",
  quoteSubmit: "Send quote request",
  quoteNextSteps: "We read every request and reply by email or phone.",
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
  industry: { kind: "fact", fact_key: "business.industry", required: true },
  offerings: { kind: "fact", fact_key: "business.offerings", required: true },
  serviceAreaText: {
    kind: "fact",
    fact_key: "service_area.text",
    required: true,
  },
  weekdayHours: { kind: "fact", fact_key: "hours.weekday", required: false },
  serviceArea: {
    kind: "fact",
    fact_key: "service_area.radius",
    required: false,
  },
  tagline: { kind: "fact", fact_key: "business.tagline", required: false },
  audience: { kind: "fact", fact_key: "business.audience", required: false },
  overview: { kind: "fact", fact_key: "business.overview", required: false },
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
  brandColor: composed,
  template: composed,
  font: composed,
  logo: { kind: "fact", fact_key: "media.uploads", required: false },
  logoAlt: composed,
  heroImage: { kind: "fact", fact_key: "media.uploads", required: false },
  heroImageAlt: composed,
  heroHeading: composed,
  homeIntro: composed,
  servicesIntro: composed,
  serviceAreaIntro: composed,
  contactIntro: composed,
  quoteIntro: composed,
  quoteFormAction: composed,
  quoteEmailSubject: composed,
  bookingIntro: composed,
  aboutHeading: composed,
  audienceHeading: composed,
  offeringsHeading: composed,
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
  quoteContactLegend: composed,
  quoteRequestLegend: composed,
  quoteNameLabel: composed,
  quoteEmailLabel: composed,
  quotePhoneLabel: composed,
  quoteServiceLabel: composed,
  quoteLocationLabel: composed,
  quoteLocationHint: composed,
  quoteDateLabel: composed,
  quoteDetailsLabel: composed,
  quoteDetailsHint: composed,
  quoteSourceLabel: composed,
  quoteChoose: composed,
  quoteOptional: composed,
  quoteSubmit: composed,
  quoteNextSteps: composed,
  phoneLabel: composed,
  emailLabel: composed,
  weekdayHoursLabel: composed,
  notFoundHeading: composed,
  notFoundBody: composed,
  homeLink: composed,
}

/** A key of `site`: every string the quote form shows is one. */
type SiteKey = keyof typeof values

/**
 * One input of the quote form. `label`, `hint` and each of `options` name a
 * `site` string, so the form's words live with the rest of the copy. `name`
 * is what the request carries, lower case. A `select` whose options are all
 * empty renders as a text input, so the service list can follow the
 * services on offer.
 */
export type QuoteField = {
  name: string
  type: "text" | "email" | "tel" | "date" | "number" | "select" | "textarea"
  label: SiteKey
  required: boolean
  hint?: SiteKey
  options?: SiteKey[]
  /** The browser's autofill token, e.g. `name`, `email`, `tel`. */
  autocomplete?: string
}

/**
 * The quote form, as fieldsets in order. Tailor it to the business: a
 * chauffeur firm asks for pickup, drop-off, date and passengers; a law firm
 * for the kind of matter. Each new label is a `site` string with a
 * `composed` field, like every other. Never ask for payment details.
 */
export const quoteForm: { legend: SiteKey; fields: QuoteField[] }[] = [
  {
    legend: "quoteContactLegend",
    fields: [
      {
        name: "name",
        type: "text",
        label: "quoteNameLabel",
        required: true,
        autocomplete: "name",
      },
      {
        name: "email",
        type: "email",
        label: "quoteEmailLabel",
        required: true,
        autocomplete: "email",
      },
      {
        name: "phone",
        type: "tel",
        label: "quotePhoneLabel",
        required: false,
        autocomplete: "tel",
      },
    ],
  },
  {
    legend: "quoteRequestLegend",
    fields: [
      {
        name: "service",
        type: "select",
        label: "quoteServiceLabel",
        required: true,
        options: ["service1Name", "service2Name", "service3Name"],
      },
      {
        name: "location",
        type: "text",
        label: "quoteLocationLabel",
        hint: "quoteLocationHint",
        required: true,
        autocomplete: "street-address",
      },
      {
        name: "date",
        type: "date",
        label: "quoteDateLabel",
        required: false,
      },
      {
        name: "details",
        type: "textarea",
        label: "quoteDetailsLabel",
        hint: "quoteDetailsHint",
        required: true,
      },
      {
        name: "source",
        type: "text",
        label: "quoteSourceLabel",
        required: false,
      },
    ],
  },
]
