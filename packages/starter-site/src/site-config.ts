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
  /** business.audience, who the business serves, as given. The only source for audienceBody. */
  audience: "",
  /** business.overview, how the business works, as given. The only source for overviewBody. */
  overview: "",
  /**
   * business.proof, what sets the business apart, as given: years trading,
   * insurance, accreditations, guarantees, awards. The only source for
   * proofBody and trust1 to trust3, which may rephrase it and never add to it.
   */
  proof: "",
  /**
   * business.disclaimer, the regulatory notice a regulated profession carries
   * ("Authorised and regulated by ..."), word for word as the owner gave it.
   * It shows in the footer. Empty without that fact: never write one.
   */
  disclaimer: "",
  /** hours.weekday for structured data, as "Mo-Fr 08:00-17:00". */
  openingHours: "",
  /** service_area.radius for structured data: the centre, as "Fairhaven". */
  areaServed: "",
  /**
   * A review as the customer's words and name, from a `testimonials.review_N`
   * fact, which holds { quote, name, permission } and is stored only once the
   * owner confirms the customer agreed to be quoted. The claims gate accepts
   * a quote only when such a fact carries it. With no fact both stay empty
   * and the section is left out. Never write one.
   */
  /** testimonials.review_1's quote, unedited and untrimmed. */
  testimonial1Quote: "",
  /** testimonials.review_1's name, exactly as given. */
  testimonial1Author: "",
  /** testimonials.review_2's quote, unedited and untrimmed. */
  testimonial2Quote: "",
  /** testimonials.review_2's name, exactly as given. */
  testimonial2Author: "",
  /**
   * Three figures for the trust strip, each the number on its own ("12",
   * "400", "4.8") and only when business.proof states it. Composed: the
   * claims gate matches the number against the facts, and no fact carries a
   * figure but business.proof.
   */
  statYearsValue: "",
  statClientsValue: "",
  statRatingValue: "",
  /**
   * The gallery's photos, by number: a path the build placed for one of the
   * Blueprint's gallery image slots, as "/uploads/<id>.jpg", and what it shows
   * in one sentence. Composed: an owner's upload or a slot's own photo, never
   * a path no slot placed. Shown only with both halves.
   */
  photo1Src: "",
  photo1Alt: "",
  photo2Src: "",
  photo2Alt: "",
  photo3Src: "",
  photo3Alt: "",
  /**
   * The design direction, an id from src/directions.json, as "calm_daylight":
   * the Blueprint's direction. It sets the radius, the dark bands, the
   * ornament, and the variant of every hero (on the home page), service
   * cards, steps, FAQ and closing band in layout that names none. An old
   * template id (classic, modern, bold) reads as its direction; anything else
   * reads as fresh_modern.
   */
  direction: "fresh_modern",
  /**
   * The palette's six roles, as "paper:#f7faf9 ink:#13201a primary:#1b4332
   * tint:#e1efe9 accent:#37aebe line:#cedfd8": a preset's roles exactly as
   * the instructions give them. It wins over brandColor. Anything short of
   * all six hex colours is ignored.
   */
  palette: "",
  /**
   * The owner's own colour, as #rrggbb, when they named one rather than a
   * palette: the six roles are derived from it. Empty is the default theme,
   * and so is anything that is not a hex colour. Do not pick one for them.
   */
  brandColor: "",
  /**
   * The font pair, an id from src/fonts.ts, as "outfit_figtree": the
   * Blueprint's fonts. The old ids (clean_sans, classic_serif, soft_rounded)
   * read as their pairs. Empty or anything else keeps the system stacks and
   * loads no font file.
   */
  font: "",
  /** media.uploads, the path of the owner's logo, as "/uploads/<id>.png". Empty shows the business name as text. */
  logo: "",
  /** The logo's alt text: the business name as the logo shows it. */
  logoAlt: "",
  /**
   * media.uploads, the path of the owner's photo the home page's hero shows,
   * as "/uploads/<id>.jpg". Empty gives the hero variant its photo-free form.
   */
  heroImage: "",
  /** What that photo shows, in one sentence: its alt text. The hero shows the photo only with it. */
  heroImageAlt: "",
  /**
   * A few words on the hero photo, as a pill or a stamp card: a fact restated
   * in under six words, as "Fully insured". Empty shows the photo bare.
   */
  heroCaption: "",
  /**
   * The home page's h1: the main service and the area, as "Weekly house
   * cleaning in Fairhaven". Falls back to the business name.
   */
  heroHeading: "",
  /**
   * The hero's subhead under the h1: two or three sentences, 25 to 55 words,
   * on who the business serves, where, and what the customer gets. Wins over
   * the tagline, which then shows in the home about section.
   */
  homeIntro: "",
  /**
   * A short reassurance line under the hero's buttons, under twelve words,
   * about how easy the next step is ("Tell us about your home and we reply
   * with a quote"). Never a claim no fact holds. Empty shows nothing.
   */
  heroNote: "",
  /**
   * Each page's <title> and meta description. A title is 50 to 60
   * characters with the service, the area and the business name; a
   * description is 140 to 160 characters with a reason to request a quote.
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
  /** Each page's lede under its h1: two or three sentences, 30 to 60 words, for that page. */
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
  /**
   * A photo for the About and Contact page headers, as a path the build placed
   * and its alt text; shown only with both, and never the home hero's photo.
   * Empty gives the header its text-only form, which needs no photo to look finished.
   */
  aboutImage: "",
  aboutImageAlt: "",
  contactImage: "",
  contactImageAlt: "",
  /** The subject line of a request sent by email. */
  quoteEmailSubject: "Quote request",
  bookingIntro: "",
  aboutEyebrow: "About",
  aboutHeading: "About us",
  /** The home page's about section h2, so it never repeats the about page's h1. Empty uses aboutHeading. */
  homeAboutHeading: "",
  /** The link from the home page's about section to the about page. */
  aboutLink: "More about us",
  overviewEyebrow: "Our story",
  overviewHeading: "How we work",
  audienceHeading: "Who we work with",
  proofEyebrow: "Our record",
  proofHeading: "What sets us apart",
  /** business.overview in the site's voice, up to 200 words in one or two paragraphs: rephrase it, never add to it. Empty shows overview as given. */
  overviewBody: "",
  /** business.audience in the site's voice, in one or two sentences: rephrase it, never add to it. Empty shows audience as given. */
  audienceBody: "",
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
  offeringsEyebrow: "The full list",
  offeringsHeading: "Everything we offer",
  valuePropsEyebrow: "Why us",
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
  /**
   * The short label above a section's h2: a word or two, set small and
   * uppercase, never a claim. Every section heading has one, and a section
   * heading may set its last clause in the accent by wrapping it in asterisks,
   * as "Why agents keep *rebooking us*". Empty leaves the heading on its own.
   */
  serviceCardsEyebrow: "Services",
  serviceCardsHeading: "What we do",
  /** The link under the service cards to the services page, off that page. */
  serviceCardsLink: "See all services",
  /** The words on each service card's link to its part of the services page. */
  serviceMoreLabel: "Explore service",
  serviceIncludesLabel: "What is included",
  serviceForLabel: "Who it is for",
  /**
   * Up to six services, one per business.offerings item that a fact
   * describes. Name; Body, 25 to 45 words, benefit first, then what it
   * covers; Detail, the intro on its own page, 60 to 100 words on what
   * the job involves and the result; Icon, a key of ICONS in
   * src/icons.ts, no key twice; Includes, what the service covers, one item
   * to a line, four to six, from the facts; For, one or two sentences on who it suits, from
   * business.audience. A card shows Name, Body and Icon and links to the
   * service's own page, which shows them all.
   */
  service1Name: "",
  service1Body: "",
  service1Detail: "",
  service1Icon: "",
  service1Includes: "",
  service1For: "",
  service2Name: "",
  service2Body: "",
  service2Detail: "",
  service2Icon: "",
  service2Includes: "",
  service2For: "",
  service3Name: "",
  service3Body: "",
  service3Detail: "",
  service3Icon: "",
  service3Includes: "",
  service3For: "",
  service4Name: "",
  service4Body: "",
  service4Detail: "",
  service4Icon: "",
  service4Includes: "",
  service4For: "",
  service5Name: "",
  service5Body: "",
  service5Detail: "",
  service5Icon: "",
  service5Includes: "",
  service5For: "",
  service6Name: "",
  service6Body: "",
  service6Detail: "",
  service6Icon: "",
  service6Includes: "",
  service6For: "",
  /**
   * A photo for each service, by number: a path the build placed, as
   * "/uploads/<id>.jpg", and its alt text. Shown only with both, on its card.
   * A fleet's photos are the owner's own uploads, never generated. Empty shows
   * the service without a photo.
   */
  service1Image: "",
  service1ImageAlt: "",
  service2Image: "",
  service2ImageAlt: "",
  service3Image: "",
  service3ImageAlt: "",
  service4Image: "",
  service4ImageAlt: "",
  service5Image: "",
  service5ImageAlt: "",
  service6Image: "",
  service6ImageAlt: "",
  /**
   * A photo for each service page's header, by number, apart from its card's:
   * a path the build placed and its alt text, shown only with both and never
   * the home hero's photo. Empty gives the header its balanced text form; a
   * header never takes the card's photo instead.
   */
  service1HeaderImage: "",
  service1HeaderImageAlt: "",
  service2HeaderImage: "",
  service2HeaderImageAlt: "",
  service3HeaderImage: "",
  service3HeaderImageAlt: "",
  service4HeaderImage: "",
  service4HeaderImageAlt: "",
  service5HeaderImage: "",
  service5HeaderImageAlt: "",
  service6HeaderImage: "",
  service6HeaderImageAlt: "",
  /**
   * Each service's own page at /services/<slug>/, the slug made from its
   * name. Heading is its h1, naming the service and the area (never the bare
   * name, which is the page's h2); Title (50 to 60 characters) and
   * Description (140 to 160) are its own; the hero's lede is Body, the intro
   * is Detail, and Includes and For follow. Step1 to Step4 are three or four
   * steps of this service alone, from first contact to the finished job
   * (a title of 2 to 5 words, a body of 20 to 35), under StepsHeading; no
   * page shares a step's words with another. Faq1 to Faq4 are two to four questions about this
   * service only, under FaqHeading; CtaHeading and CtaBody are its closing
   * band. Every heading is the site's only one of its words.
   */
  service1Heading: "",
  service1Title: "",
  service1Description: "",
  service1StepsHeading: "",
  service1Step1Title: "",
  service1Step1Body: "",
  service1Step2Title: "",
  service1Step2Body: "",
  service1Step3Title: "",
  service1Step3Body: "",
  service1Step4Title: "",
  service1Step4Body: "",
  service1FaqHeading: "",
  service1Faq1Question: "",
  service1Faq1Answer: "",
  service1Faq2Question: "",
  service1Faq2Answer: "",
  service1Faq3Question: "",
  service1Faq3Answer: "",
  service1Faq4Question: "",
  service1Faq4Answer: "",
  service1CtaHeading: "",
  service1CtaBody: "",
  service2Heading: "",
  service2Title: "",
  service2Description: "",
  service2StepsHeading: "",
  service2Step1Title: "",
  service2Step1Body: "",
  service2Step2Title: "",
  service2Step2Body: "",
  service2Step3Title: "",
  service2Step3Body: "",
  service2Step4Title: "",
  service2Step4Body: "",
  service2FaqHeading: "",
  service2Faq1Question: "",
  service2Faq1Answer: "",
  service2Faq2Question: "",
  service2Faq2Answer: "",
  service2Faq3Question: "",
  service2Faq3Answer: "",
  service2Faq4Question: "",
  service2Faq4Answer: "",
  service2CtaHeading: "",
  service2CtaBody: "",
  service3Heading: "",
  service3Title: "",
  service3Description: "",
  service3StepsHeading: "",
  service3Step1Title: "",
  service3Step1Body: "",
  service3Step2Title: "",
  service3Step2Body: "",
  service3Step3Title: "",
  service3Step3Body: "",
  service3Step4Title: "",
  service3Step4Body: "",
  service3FaqHeading: "",
  service3Faq1Question: "",
  service3Faq1Answer: "",
  service3Faq2Question: "",
  service3Faq2Answer: "",
  service3Faq3Question: "",
  service3Faq3Answer: "",
  service3Faq4Question: "",
  service3Faq4Answer: "",
  service3CtaHeading: "",
  service3CtaBody: "",
  service4Heading: "",
  service4Title: "",
  service4Description: "",
  service4StepsHeading: "",
  service4Step1Title: "",
  service4Step1Body: "",
  service4Step2Title: "",
  service4Step2Body: "",
  service4Step3Title: "",
  service4Step3Body: "",
  service4Step4Title: "",
  service4Step4Body: "",
  service4FaqHeading: "",
  service4Faq1Question: "",
  service4Faq1Answer: "",
  service4Faq2Question: "",
  service4Faq2Answer: "",
  service4Faq3Question: "",
  service4Faq3Answer: "",
  service4Faq4Question: "",
  service4Faq4Answer: "",
  service4CtaHeading: "",
  service4CtaBody: "",
  service5Heading: "",
  service5Title: "",
  service5Description: "",
  service5StepsHeading: "",
  service5Step1Title: "",
  service5Step1Body: "",
  service5Step2Title: "",
  service5Step2Body: "",
  service5Step3Title: "",
  service5Step3Body: "",
  service5Step4Title: "",
  service5Step4Body: "",
  service5FaqHeading: "",
  service5Faq1Question: "",
  service5Faq1Answer: "",
  service5Faq2Question: "",
  service5Faq2Answer: "",
  service5Faq3Question: "",
  service5Faq3Answer: "",
  service5Faq4Question: "",
  service5Faq4Answer: "",
  service5CtaHeading: "",
  service5CtaBody: "",
  service6Heading: "",
  service6Title: "",
  service6Description: "",
  service6StepsHeading: "",
  service6Step1Title: "",
  service6Step1Body: "",
  service6Step2Title: "",
  service6Step2Body: "",
  service6Step3Title: "",
  service6Step3Body: "",
  service6Step4Title: "",
  service6Step4Body: "",
  service6FaqHeading: "",
  service6Faq1Question: "",
  service6Faq1Answer: "",
  service6Faq2Question: "",
  service6Faq2Answer: "",
  service6Faq3Question: "",
  service6Faq3Answer: "",
  service6Faq4Question: "",
  service6Faq4Answer: "",
  service6CtaHeading: "",
  service6CtaBody: "",
  stepsEyebrow: "Process",
  stepsHeading: "How it works",
  /** Three or four steps from first contact to the finished job: a title and 20 to 35 words each. */
  step1Title: "",
  step1Body: "",
  step2Title: "",
  step2Body: "",
  step3Title: "",
  step3Body: "",
  step4Title: "",
  step4Body: "",
  statYearsLabel: "Years in business",
  statClientsLabel: "Clients served",
  statRatingLabel: "Average rating",
  testimonialsEyebrow: "Reviews",
  testimonialsHeading: "What clients say",
  galleryEyebrow: "Gallery",
  galleryHeading: "Our work",
  areaEyebrow: "Coverage",
  /**
   * The places service_area.text names, one to a line, and nothing it does
   * not name. Empty shows service_area.text as given.
   */
  areaTowns: "",
  /** A paragraph of 40 to 80 words on working in the area, with no landmark, venue or time the facts do not give. */
  areaBody: "",
  /** The home page's area section h2, so it never repeats the service area page's h1. Empty uses serviceAreaHeading. */
  homeAreaHeading: "",
  /** The link from the home page's area section to the service area page. */
  areaLink: "See the areas we cover",
  /** The labels on the area section's two rows: the place, and hours when hours.weekday is given. */
  areaPlaceLabel: "Service area",
  areaHoursLabel: "Hours",
  /** The small label on the card over the area drawing. */
  areaCardLabel: "Where we work",
  /** The card's line, 3 to 7 words on being local, as "Right around the corner". Empty shows service_area.text. */
  areaCardLine: "",
  /**
   * The service area page's line under a town, one to a line as "Oakley:
   * weekly cleans for the terraces by the green", for towns in areaTowns
   * only, spelled as there. A town with no line is listed alone; empty lists
   * every town alone.
   */
  areaTownNotes: "",
  faqEyebrow: "Questions",
  faqHeading: "Common questions",
  /** One or two sentences under the FAQ heading, beside the questions. Empty leaves the heading alone. */
  faqIntro: "",
  /** The link under the FAQ intro to the contact page, off that page. */
  faqLink: "Ask us something else",
  /**
   * Five to eight questions a customer of this trade asks before booking,
   * each answered in 40 to 90 words: the trade's usual practice in general
   * terms, and this business's own policy only as a fact states it. Never a
   * price.
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
  ctaEyebrow: "Next step",
  /** The closing band on every page: a headline of 4 to 9 words and one sentence of 12 to 30 words. */
  ctaHeading: "",
  ctaBody: "",
  /**
   * The closing band of each other page, so no two pages share its heading.
   * Empty falls back to ctaHeading and ctaBody, the home page's.
   */
  aboutCtaHeading: "",
  aboutCtaBody: "",
  servicesCtaHeading: "",
  servicesCtaBody: "",
  serviceAreaCtaHeading: "",
  serviceAreaCtaBody: "",
  contactCtaHeading: "",
  contactCtaBody: "",
  /** The band's button text. Empty uses the label of the page it links to. */
  ctaLabel: "",
  /** A photo behind the closing band, under the brand colour; decoration, so no alt. */
  ctaImage: "",
  /** The quote page's side column: what happens after a visitor sends the form. */
  quoteEyebrow: "Your quote",
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
  disclaimer: fact("business.disclaimer"),
  openingHours: fact("hours.weekday"),
  areaServed: fact("service_area.radius"),
  testimonial1Quote: fact("testimonials.review_1"),
  testimonial1Author: fact("testimonials.review_1"),
  testimonial2Quote: fact("testimonials.review_2"),
  testimonial2Author: fact("testimonials.review_2"),
  logo: fact("media.uploads"),
  heroImage: fact("media.uploads"),
}

export const fields = Object.fromEntries(
  Object.keys(site).map((key) => [
    key,
    FACTS[key as keyof typeof site] ?? { kind: "composed" },
  ])
) as Record<keyof typeof site, Field>

/**
 * The sections of each page, in order. src/layouts/Sections.astro renders
 * them, so composing a page is editing this data: reorder, drop, or change a
 * variant. A section with no content behind it renders nothing, whatever its
 * place here. `kind` and `variant` are the contract's SECTION_VARIANTS (a test
 * fails when they drift). A section with no variant takes site.direction's:
 * the hero only on the home page (elsewhere it is the plain page hero), and
 * service cards, steps, FAQ and closing band on every page. Name a variant
 * only where the Blueprint changes the direction's.
 */
export type LayoutSection = {
  kind:
    | "hero"
    | "trust_strip"
    | "service_cards"
    | "value_props"
    | "steps"
    | "about"
    | "testimonials"
    | "gallery"
    | "service_area"
    | "faq"
    | "cta_band"
    | "contact"
    | "quote_form"
  variant?: string
}
export type LayoutPage =
  | "home"
  | "about"
  | "services"
  | "service"
  | "service_area"
  | "contact"
  | "quote"

export const layout: Record<LayoutPage, LayoutSection[]> = {
  home: [
    { kind: "hero" },
    { kind: "trust_strip", variant: "icons" },
    { kind: "service_cards" },
    { kind: "value_props" },
    { kind: "steps" },
    { kind: "about" },
    { kind: "testimonials", variant: "wall" },
    { kind: "gallery" },
    { kind: "service_area" },
    { kind: "faq" },
    { kind: "cta_band" },
  ],
  about: [
    { kind: "hero" },
    { kind: "trust_strip", variant: "icons" },
    { kind: "about" },
    { kind: "cta_band" },
  ],
  services: [
    { kind: "hero" },
    { kind: "service_cards", variant: "photo_cards" },
    { kind: "cta_band" },
  ],
  service: [
    { kind: "hero" },
    { kind: "service_cards", variant: "alternating" },
    { kind: "steps" },
    { kind: "faq" },
    { kind: "cta_band" },
  ],
  service_area: [
    { kind: "hero" },
    { kind: "service_area" },
    { kind: "cta_band" },
  ],
  contact: [{ kind: "hero" }, { kind: "contact" }, { kind: "cta_band" }],
  quote: [{ kind: "hero" }, { kind: "quote_form" }],
}
