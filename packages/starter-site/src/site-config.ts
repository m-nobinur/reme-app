/**
 * The site's own settings, its facts as shown, its labels, its photos and its
 * services, which several pages show; `fields` says what each one needs. A
 * page's words are its document, src/content/pages/<page>.json (the slots a
 * first build's writers fill are src/page-fields.ts). This file imports
 * nothing, so it builds anywhere the site does.
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
  /** The footer's one line under the business name: under twelve words, in its own wording, never the hero's subhead. Empty falls back to the tagline. */
  footerBlurb: "",
  /**
   * A photo for the About and Contact page headers, as a path the build placed
   * and its alt text; shown only with both, and never the home hero's photo.
   * Empty gives the header its text-only form, which needs no photo to look finished.
   */
  aboutImage: "",
  aboutImageAlt: "",
  contactImage: "",
  contactImageAlt: "",
  /** The link from that note to the quote form. */
  contactFormLink: "Use the quote form",
  /**
   * The quote page's privacy line under the form: what happens to the
   * details sent, only as true of how the form works (they go to the
   * business, to prepare the quote) or as a fact states. Empty shows nothing.
   */
  quotePrivacy: "",
  bookingIntro: "",
  /** The link from the home page's about section to the about page. */
  aboutLink: "More about us",
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
  /** The link under the service cards to the services page, off that page. */
  serviceCardsLink: "See all services",
  /** The words on each service card's link to its part of the services page. */
  serviceMoreLabel: "Explore service",
  serviceIncludesLabel: "What it usually covers",
  /**
   * The muted line under trade guidance: a block whose provenance is trade,
   * and the list under serviceIncludesLabel. Empty shows nothing.
   */
  typicalNote:
    "Typical for this kind of job. We confirm the details when we quote.",
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
  statYearsLabel: "Years in business",
  statClientsLabel: "Clients served",
  statRatingLabel: "Average rating",
  /**
   * The places service_area.text names, one to a line, and nothing it does
   * not name. Empty shows service_area.text as given.
   */
  areaTowns: "",
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
  /** The link under the FAQ intro to the contact page, off that page. */
  faqLink: "Ask us something else",
  /** The band's button text. Empty uses the label of the page it links to. */
  ctaLabel: "",
  /** A photo behind the closing band, under the brand colour; decoration, so no alt. */
  ctaImage: "",
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
  /** In the photo question's drop zone: up to five JPEG, PNG or WebP photos. */
  quotePhotoDrop: "Drop photos here, or choose them",
  quotePhotoLinks: "Links to photos, one per line",
  quoteOptional: "optional",
  quoteSubmit: "Send quote request",
  quoteNextSteps: "Your request comes straight to us.",
  /** Above the form once a request has gone, and once one could not go. */
  quoteSent: "Thank you. Your request has reached us.",
  quoteNotSent:
    "Your request did not send. Try again in a minute, or call or email us instead.",
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
