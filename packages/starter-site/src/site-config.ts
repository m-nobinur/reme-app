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
 * all empty renders nothing at all, heading included. Fill what the facts
 * support and leave the rest empty: a short page beats a padded one.
 *
 * `fields` is read in declaration order when asking for missing facts, so the
 * required facts come first. Its keys are exactly the keys of `site`: every
 * key in FACTS is a fact field and every other key is composed.
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
  /**
   * business.proof, what sets the business apart, as given: years trading,
   * insurance, accreditations, guarantees, awards. The only source for
   * proofBody and trust1 to trust3, which may rephrase it and never add to it.
   */
  proof: "",
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
   * soft_rounded. Empty or anything else keeps the template's own type.
   */
  font: "",
  /** media.uploads, the path of the owner's logo, as "/uploads/<id>.png". Empty shows the business name as text. */
  logo: "",
  /** The logo's alt text: the business name as the logo shows it. */
  logoAlt: "",
  /**
   * media.uploads, the path of the owner's photo the home page's hero shows,
   * as "/uploads/<id>.jpg". Empty gives each template its photo-free hero.
   */
  heroImage: "",
  /** What that photo shows, in one sentence: its alt text. The hero shows the photo only with it. */
  heroImageAlt: "",
  /**
   * The home page's h1: the main service and the area, as "Weekly house
   * cleaning in Fairhaven". Falls back to the business name.
   */
  heroHeading: "",
  /** One sentence: what a customer gets. Under the h1 when there is no tagline. */
  homeIntro: "",
  /**
   * Each page's <title> and meta description. A title is 50 to 60
   * characters with the service, the area and the business name; a
   * description is 140 to 155 characters with a reason to request a quote.
   * Empty falls back to the page's heading and intro.
   */
  homeTitle: "",
  homeDescription: "",
  aboutTitle: "",
  aboutDescription: "",
  servicesTitle: "",
  servicesDescription: "",
  serviceAreaTitle: "",
  serviceAreaDescription: "",
  contactTitle: "",
  contactDescription: "",
  quoteTitle: "",
  quoteDescription: "",
  /** Each page's lede under its h1: one or two sentences for that page. */
  aboutIntro: "",
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
  /** The link from the home page's about section to the about page. */
  aboutLink: "More about us",
  overviewHeading: "How we work",
  audienceHeading: "Who we work with",
  proofHeading: "What sets us apart",
  /** business.proof in the site's voice, in two to four sentences. Empty shows proof as given. */
  proofBody: "",
  /**
   * The trust strip under the home hero: up to three short points, under six
   * words each, each restating part of business.proof ("Fully insured",
   * "Trading since 2009"). Empty without that fact.
   */
  trust1: "",
  trust2: "",
  trust3: "",
  offeringsHeading: "Everything we offer",
  valuePropsHeading: "Why choose us",
  /**
   * Three reasons to choose the business, each a fact or business.proof put
   * as a benefit. An icon is a key of ICONS in src/icons.ts that shows what
   * its card says, as "calendarCheck"; empty shows checkCircle.
   */
  valueProp1Title: "",
  valueProp1Body: "",
  valueProp1Icon: "",
  valueProp2Title: "",
  valueProp2Body: "",
  valueProp2Icon: "",
  valueProp3Title: "",
  valueProp3Body: "",
  valueProp3Icon: "",
  serviceCardsHeading: "What we do",
  /** The link under the service cards to the services page, off that page. */
  serviceCardsLink: "See all services",
  serviceIncludesLabel: "What is included",
  serviceForLabel: "Who it is for",
  /**
   * Up to six services, one per business.offerings item that a fact
   * describes. Name; Body, one benefit-led sentence; Icon, a key of ICONS in
   * src/icons.ts, no key twice; Includes, what the service covers, one item
   * to a line, from the facts; For, one sentence on who it suits, from
   * business.audience. A card shows Name, Body and Icon; the services page
   * shows them all.
   */
  service1Name: "",
  service1Body: "",
  service1Icon: "",
  service1Includes: "",
  service1For: "",
  service2Name: "",
  service2Body: "",
  service2Icon: "",
  service2Includes: "",
  service2For: "",
  service3Name: "",
  service3Body: "",
  service3Icon: "",
  service3Includes: "",
  service3For: "",
  service4Name: "",
  service4Body: "",
  service4Icon: "",
  service4Includes: "",
  service4For: "",
  service5Name: "",
  service5Body: "",
  service5Icon: "",
  service5Includes: "",
  service5For: "",
  service6Name: "",
  service6Body: "",
  service6Icon: "",
  service6Includes: "",
  service6For: "",
  stepsHeading: "How it works",
  /** Three steps from first contact to the finished job. */
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
  /**
   * The places service_area.text names, one to a line, and nothing it does
   * not name. Empty shows service_area.text as given.
   */
  areaTowns: "",
  /** A short paragraph on working in the area, with no landmark, venue or time the facts do not give. */
  areaBody: "",
  /** The link from the home page's area section to the service area page. */
  areaLink: "See the areas we cover",
  faqHeading: "Common questions",
  /**
   * Six to eight questions a customer of this trade asks before booking,
   * each answered from a fact in one or two sentences. Fewer when the facts
   * answer fewer; never a price.
   */
  faq1Question: "",
  faq1Answer: "",
  faq2Question: "",
  faq2Answer: "",
  faq3Question: "",
  faq3Answer: "",
  faq4Question: "",
  faq4Answer: "",
  faq5Question: "",
  faq5Answer: "",
  faq6Question: "",
  faq6Answer: "",
  faq7Question: "",
  faq7Answer: "",
  faq8Question: "",
  faq8Answer: "",
  ctaHeading: "",
  ctaBody: "",
  /** The band's button text. Empty uses the label of the page it links to. */
  ctaLabel: "",
  /** The quote page's side column: what happens after a visitor sends the form. */
  quoteAsideHeading: "What happens next",
  quoteNext1: "Send the form with as much detail as you can.",
  quoteNext2: "We read your request and check what the job needs.",
  quoteNext3: "We reply by email or phone with your quote.",
  quoteTalkHeading: "Rather talk it through?",
  skipLink: "Skip to content",
  primaryNavLabel: "Main",
  footerNavLabel: "Footer",
  /** The button that opens the navigation on a phone. */
  navMenu: "Menu",
  navHome: "Home",
  navAbout: "About",
  navServices: "Services",
  navServiceArea: "Service area",
  navContact: "Contact",
  navQuote: "Request a quote",
  /** Empty until the booking page ships, so no menu links to it. */
  navBooking: "",
  footerPagesHeading: "Pages",
  footerContactHeading: "Get in touch",
  servicesHeading: "Services",
  serviceAreaHeading: "Service area",
  contactHeading: "Contact",
  quoteHeading: "Request a quote",
  bookingHeading: "Make a booking",
  quoteContactLegend: "Your details",
  /**
   * The legend over the owner's own questions. The questions are in
   * src/quote-form.json, which the platform writes and nobody edits.
   */
  quoteRequestLegend: "Your request",
  quoteNameLabel: "Your name",
  quoteEmailLabel: "Email address",
  quotePhoneLabel: "Phone number",
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

const fact = (fact_key: string, required = false): Field => ({
  kind: "fact",
  fact_key,
  required,
})

/** The fields that render a fact; every other field is composed. */
const FACTS: Partial<Record<keyof typeof site, Field>> = {
  businessName: fact("business.name", true),
  phone: fact("business.phone", true),
  email: fact("business.email", true),
  industry: fact("business.industry", true),
  offerings: fact("business.offerings", true),
  serviceAreaText: fact("service_area.text", true),
  weekdayHours: fact("hours.weekday"),
  serviceArea: fact("service_area.radius"),
  tagline: fact("business.tagline"),
  audience: fact("business.audience"),
  overview: fact("business.overview"),
  proof: fact("business.proof"),
  openingHours: fact("hours.weekday"),
  areaServed: fact("service_area.radius"),
  testimonial1Quote: fact("testimonials.quote_1"),
  testimonial1Author: fact("testimonials.author_1"),
  testimonial2Quote: fact("testimonials.quote_2"),
  testimonial2Author: fact("testimonials.author_2"),
  statYearsValue: fact("about.years_in_business"),
  statClientsValue: fact("about.clients_served"),
  statRatingValue: fact("reviews.average_rating"),
  photo1Src: fact("media.photo_1"),
  photo1Alt: fact("media.photo_1_alt"),
  photo2Src: fact("media.photo_2"),
  photo2Alt: fact("media.photo_2_alt"),
  photo3Src: fact("media.photo_3"),
  photo3Alt: fact("media.photo_3_alt"),
  logo: fact("media.uploads"),
  heroImage: fact("media.uploads"),
}

export const fields = Object.fromEntries(
  Object.keys(site).map((key) => [
    key,
    FACTS[key as keyof typeof site] ?? { kind: "composed" },
  ])
) as Record<keyof typeof site, Field>
