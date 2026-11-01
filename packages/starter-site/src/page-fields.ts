/**
 * The page slots a first build's writers fill, each with what it needs, and
 * their defaults. The platform writes their words into each page's document,
 * src/content/pages/<page>.json, with the Blueprint's sections, so editing
 * this file changes nothing on the site: a page's words are its document.
 * src/page-seed.ts reads these defaults, and `layout`, for a page with no
 * document yet. Numbered slots are one list each, filled from 1 upwards, and
 * a slot left empty leaves its part of the page out. Imports nothing.
 */
const slots = {
  /**
   * The small label above the home page's h1, a few words such as "Trusted
   * home cleaners". Empty shows the trade's name (industry).
   */
  heroEyebrow: "",
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
   * The contact page's note beside the details: what to put in a message so
   * the reply can be useful (the job, the place, the timing, access), 25 to
   * 60 words, under contactIncludeHeading. When a fact gives a reply time it
   * may say so; otherwise it promises no reply time and no reply to every
   * message.
   */
  contactIncludeEyebrow: "Before you write",
  contactIncludeHeading: "",
  contactIncludeBody: "",
  aboutEyebrow: "About",
  aboutHeading: "About us",
  /** The home page's about section h2, so it never repeats the about page's h1. Empty uses aboutHeading. */
  homeAboutHeading: "",
  overviewEyebrow: "Our story",
  overviewHeading: "How we work",
  audienceHeading: "Who we work with",
  proofEyebrow: "Our record",
  proofHeading: "What sets us apart",
  /** business.overview in the site's voice, up to 200 words in one or two paragraphs: rephrase it, never add to it. Empty shows overview as given. */
  overviewBody: "",
  /** business.audience in the site's voice, in one or two sentences: rephrase it, never add to it. Empty shows audience as given. */
  audienceBody: "",
  /**
   * business.proof in the site's voice, two to four sentences and 30 to 60
   * words, beside the record's items: what each point means for the
   * customer, never a point the fact does not make. Empty shows proof as given.
   */
  proofBody: "",
  /**
   * The about page's approach: three or four principles of how the work is
   * done, each a title of 2 to 5 words and a body of 25 to 45 words, drawn
   * from the facts and the trade's normal good practice. Never a credential,
   * a guarantee or a number no fact states. An icon is a key of ICONS in
   * src/icons.ts; empty is picked from the words.
   */
  approachEyebrow: "Our approach",
  approachHeading: "",
  approach1Title: "",
  approach1Body: "",
  approach1Icon: "",
  approach2Title: "",
  approach2Body: "",
  approach2Icon: "",
  approach3Title: "",
  approach3Body: "",
  approach3Icon: "",
  approach4Title: "",
  approach4Body: "",
  approach4Icon: "",
  /**
   * The about page's "what to expect" steps: three or four, from arriving to
   * leaving the job finished, each a title of 2 to 5 words and a body of 20
   * to 35, sharing no words with the home page's steps or a service's. No
   * time, duration or promise a fact does not state.
   */
  aboutStepsHeading: "",
  aboutStep1Title: "",
  aboutStep1Body: "",
  aboutStep2Title: "",
  aboutStep2Body: "",
  aboutStep3Title: "",
  aboutStep3Body: "",
  aboutStep4Title: "",
  aboutStep4Body: "",
  /** The about page's area section h2, its own words. Empty shows the section without one. */
  aboutAreaHeading: "",
  /**
   * The services page's helper for a visitor not sure which service they
   * need: 40 to 80 words on which service suits which home, job or
   * situation, from the services and business.audience, ending with the
   * offer to describe the job instead. No price or promise.
   */
  servicesHelpEyebrow: "Not sure?",
  servicesHelpHeading: "",
  servicesHelpBody: "",
  /**
   * The services page's own questions: two to four about choosing between
   * the services or what each covers, never one the home page's FAQ asks,
   * each answer 40 to 90 words, under servicesFaqHeading.
   */
  servicesFaqHeading: "",
  servicesFaq1Question: "",
  servicesFaq1Answer: "",
  servicesFaq2Question: "",
  servicesFaq2Answer: "",
  servicesFaq3Question: "",
  servicesFaq3Answer: "",
  servicesFaq4Question: "",
  servicesFaq4Answer: "",
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
  testimonialsEyebrow: "Reviews",
  testimonialsHeading: "What clients say",
  galleryEyebrow: "Gallery",
  galleryHeading: "Our work",
  areaEyebrow: "Coverage",
  /** A paragraph of 40 to 80 words on working in the area, with no landmark, venue or time the facts do not give. */
  areaBody: "",
  /** The home page's area section h2, so it never repeats the service area page's h1. Empty uses serviceAreaHeading. */
  homeAreaHeading: "",
  faqEyebrow: "Questions",
  faqHeading: "Common questions",
  /** One or two sentences under the FAQ heading, beside the questions. Empty leaves the heading alone. */
  faqIntro: "",
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
  /** The quote page's side column: what happens after a visitor sends the form. */
  quoteEyebrow: "Your quote",
  quoteAsideHeading: "What happens next",
  quoteNext1: "Send the form with as much detail as you can.",
  quoteNext2: "We read your request and check what the job needs.",
  quoteNext3: "We reply by email or phone with your quote.",
  servicesHeading: "Services",
  serviceAreaHeading: "Service area",
  contactHeading: "Contact",
  quoteHeading: "Request a quote",
}

/** Typed as strings, not literals: the writers fill these. */
export const pageFields: Record<keyof typeof slots, string> = slots

/**
 * The sections of each page, in order, for a page with no document yet: a
 * first build's documents take the Blueprint's instead. A section with no
 * content behind it renders nothing, whatever its place here. `kind` and `variant` are the contract's SECTION_VARIANTS (a test
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
    | "content"
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
    { kind: "about" },
    { kind: "value_props" },
    { kind: "cta_band" },
  ],
  services: [
    { kind: "hero" },
    { kind: "service_cards", variant: "photo_cards" },
    { kind: "content" },
    { kind: "cta_band" },
  ],
  service: [
    { kind: "hero" },
    { kind: "service_cards", variant: "alternating" },
    { kind: "content" },
    { kind: "content" },
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
