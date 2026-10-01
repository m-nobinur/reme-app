import { site } from "../src/site-config"

/**
 * The golden fixture business, rendered the way the Developer renders facts
 * into the config. Fictional: a 555 number and an .invalid address.
 */
export const FILLED: Record<string, string> = {
  ...site,
  businessName: "BrightClean",
  phone: "+15550142",
  email: "hello@brightclean.invalid",
  industry: "Cleaning and home services",
  offerings: "Weekly cleaning\nDeep cleaning\nEnd of tenancy cleaning",
  serviceAreaText: "Fairhaven and the villages around it",
  audience: "Households with busy weeks and pets underfoot.",
  overview: "One cleaner keeps each home, on the same day every week.",
  weekdayHours: "08:00 to 17:00",
  serviceArea: "Within 25 km of Fairhaven",
  openingHours: "Mo-Fr 08:00-17:00",
  areaServed: "Fairhaven",
  testimonial1Quote: "They have never missed a week.",
  testimonial1Author: "Dana R.",
  testimonial2Quote: "Booked on a Monday, cleaned on the Tuesday.",
  testimonial2Author: "Sam O.",
  statYearsValue: "12",
  statClientsValue: "400",
  statRatingValue: "4.8",
  photo1Src: "/photos/one.jpg",
  photo1Alt: "A kitchen worktop after a clean",
  photo2Src: "/photos/two.jpg",
  photo2Alt: "A hallway floor after a clean",
  photo3Src: "/photos/three.jpg",
  photo3Alt: "A bathroom mirror after a clean",
  logo: "/uploads/logo.png",
  logoAlt: "BrightClean",
  heroImage: "/uploads/hero.jpg",
  heroImageAlt: "A living room after a weekly clean",
  heroHeading: "A home you come back to",
  tagline: "Weekly cleaning for homes in Fairhaven",
  homeIntro: "We clean homes on a schedule the household picks.",
  servicesIntro: "Three ways we clean, and what each one covers.",
  serviceAreaIntro: "Where a cleaner can reach you.",
  contactIntro: "Call, write, or ask for a quote.",
  homeTitle: "Weekly and deep house cleaning in Fairhaven | BrightClean",
  homeDescription:
    "BrightClean sends the same cleaner to your home on the same day each week, across Fairhaven and nearby villages. Tell us about your home for a quote.",
  servicesTitle: "Weekly, deep and end of tenancy cleaning | BrightClean",
  servicesDescription:
    "Weekly cleans, deep cleans and end of tenancy cleans for homes in Fairhaven and the villages around it. See what each covers and request a quote.",
  serviceAreaTitle:
    "House cleaning in Fairhaven and nearby villages | BrightClean",
  serviceAreaDescription:
    "BrightClean cleans homes in Fairhaven and the villages around it, within 25 km of the town. Check you are covered, then request a quote for your home.",
  contactTitle: "Contact BrightClean | House cleaning in Fairhaven",
  contactDescription:
    "Call or email BrightClean about weekly, deep or end of tenancy cleaning in Fairhaven, weekdays 08:00 to 17:00, or request a quote online any time.",
  quoteTitle: "Request a cleaning quote in Fairhaven | BrightClean",
  quoteDescription:
    "Tell BrightClean about your home, the clean you need and when, and we reply by email or phone with a quote. Covering Fairhaven and nearby villages.",
  proof:
    "Trading in Fairhaven since 2014. Fully insured. Every cleaner is employed by us, not an agency.",
  proofBody:
    "We have cleaned homes in Fairhaven since 2014. We are fully insured, and every cleaner works for us directly rather than through an agency.",
  trust1: "Cleaning Fairhaven since 2014",
  trust2: "Fully insured",
  trust3: "Our own employed cleaners",
  aboutTitle: "About BrightClean | House cleaners in Fairhaven",
  aboutDescription:
    "BrightClean has cleaned homes in Fairhaven since 2014 with its own insured cleaners. Meet the team behind your weekly clean and request a quote.",
  aboutIntro: "A local cleaning firm with its own cleaners, not an agency.",
  overviewHeading: "One cleaner for every home in Fairhaven",
  overviewBody:
    "Your home gets one cleaner, who learns how you like it kept. They come on the same day every week, so you always know when.",
  audienceHeading: "Homes we clean for",
  audienceBody:
    "We clean for households with busy weeks, and for homes with pets underfoot.",
  proofHeading: "Why Fairhaven trusts us",
  service1Includes:
    "Kitchen surfaces and appliances wiped\nBathrooms cleaned\nFloors vacuumed and mopped\nBins emptied",
  service1For: "Households who want the house kept on top of every week.",
  service2Includes:
    "Inside the oven and fridge\nSkirting boards and door frames\nLimescale removed from taps and tiles",
  service2For: "Homes that need a reset before a weekly routine starts.",
  service3Includes:
    "Every room top to bottom\nInside cupboards and appliances\nWindows cleaned inside",
  service3For: "Tenants handing back keys and landlords between lets.",
  areaTowns: "Fairhaven\nOakley\nBrook Green",
  areaBody:
    "We clean homes across Fairhaven and the villages around it, so your cleaner is never far away.",
  faq4Question: "Is the same cleaner sent every week?",
  faq4Answer: "Yes. One cleaner keeps each home, on the same day every week.",
  faq5Question: "Which areas do you cover?",
  faq5Answer: "Fairhaven and the villages around it, within 25 km of the town.",
  faq6Question: "Are you insured?",
  faq6Answer: "Yes, we are fully insured.",
  service1Icon: "house",
  service2Icon: "sprayBottle",
  service3Icon: "key",
  valueProp1Icon: "handshake",
  valueProp2Icon: "broom",
  valueProp3Icon: "calendarCheck",
  valueProp1Title: "The same cleaner",
  valueProp1Body: "One cleaner learns your home and keeps it.",
  valueProp2Title: "Nothing to buy",
  valueProp2Body: "The kit arrives with the cleaner.",
  valueProp3Title: "Easy to move",
  valueProp3Body: "Change a visit by telephone.",
  service1Name: "Weekly clean",
  service1Body: "Kitchen, bathrooms, floors and surfaces.",
  service2Name: "Deep clean",
  service2Body: "A longer visit that reaches what a weekly clean skips.",
  service3Name: "End of tenancy",
  service3Body: "A clean for handing back the keys.",
  step1Title: "Tell us about the home",
  step1Body: "Rooms, floors and anything that needs care.",
  step2Title: "Agree a visit",
  step2Body: "Pick a day that suits the household.",
  step3Title: "Come home to it done",
  step3Body: "The same cleaner, on the same day.",
  faq1Question: "Do I need to be in?",
  faq1Answer: "No, as long as the cleaner can get in.",
  faq2Question: "Do you bring what you need?",
  faq2Answer: "Yes, the kit comes with the cleaner.",
  faq3Question: "Can I move a visit?",
  faq3Answer: "Yes, by telephone.",
  ctaHeading: "Ready for a clean home?",
  ctaBody: "Tell us about the home and we take it from there.",
}

/** The same business with no proof: no figures, reviews, proof or trust points. */
export const NO_PROOF: Record<string, string> = {
  ...FILLED,
  proof: "",
  proofBody: "",
  trust1: "",
  trust2: "",
  trust3: "",
  statYearsValue: "",
  statClientsValue: "",
  statRatingValue: "",
  testimonial1Quote: "",
  testimonial1Author: "",
  testimonial2Quote: "",
  testimonial2Author: "",
  faq6Question: "",
  faq6Answer: "",
}

/** The same business with no photos and no logo. */
export const NO_PHOTOS: Record<string, string> = {
  ...FILLED,
  logo: "",
  logoAlt: "",
  heroImage: "",
  heroImageAlt: "",
  photo1Src: "",
  photo1Alt: "",
  photo2Src: "",
  photo2Alt: "",
  photo3Src: "",
  photo3Alt: "",
}

/**
 * A chauffeur firm's own questions, as the owner might approve them in
 * onboarding: every kind of input the form renders, so a build with it shows
 * the form following the data rather than the starter's defaults.
 */
export const LIMOUSINE_FORM = {
  fields: [
    {
      key: "pickup",
      label: "Pick-up address",
      type: "text",
      required: true,
      hint: "Street and town",
      options: null,
    },
    {
      key: "dropoff",
      label: "Drop-off address",
      type: "text",
      required: true,
      hint: null,
      options: null,
    },
    {
      key: "pickup_date",
      label: "Date of the journey",
      type: "date",
      required: true,
      hint: null,
      options: null,
    },
    {
      key: "passengers",
      label: "Passengers",
      type: "number",
      required: true,
      hint: null,
      options: null,
    },
    {
      key: "occasion",
      label: "Occasion",
      type: "select",
      required: false,
      hint: null,
      options: ["Wedding", "Airport transfer", "Night out", "Business"],
    },
    {
      key: "notes",
      label: "Anything else",
      type: "textarea",
      required: false,
      hint: "Luggage, child seats or stops on the way",
      options: null,
    },
  ],
}
