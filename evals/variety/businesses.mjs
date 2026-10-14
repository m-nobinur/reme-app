/**
 * EV1's 18 fictional businesses, six each in cleaning, legal and limousine.
 * Nothing here may be mistaken for a real business: every name and town is
 * invented, every phone number is in the 555-0100 to 555-0199 block the NANP
 * reserves for fiction, every email is on example.com (RFC 2606). The test
 * file checks all three.
 *
 * Richness, two of each six: `bare` (the required facts and no photos),
 * `photos` (adds a tagline, hours and three uploads) and `full` (every fact the
 * onboarding learns, and three uploads). Tray, three of each six: `skip` leaves
 * every design choice to the planner; `answer` picks from the tray, and the
 * three answerers in an industry overlap on purpose (two pick the same
 * everything, the third shares palette and fonts), so the planner's diversity
 * note is tested where it matters.
 *
 * The tray's question ids (`palette`, `fonts`, `layout`) and the layout choice
 * id (`<hero>__<services>`) are this file's convention until OI4's tray builder
 * fixes them; `toFacts` and `toTray` are the only places that know.
 */

const ENTRIES = [
  // cleaning
  [
    "clean-01",
    "cleaning",
    "Thimbleberry Home Cleaning",
    "Nettlewick",
    206,
    100,
    "thimbleberry",
    [
      "Weekly house cleaning",
      "Deep cleaning",
      "Move-out cleaning",
      "Oven and fridge cleaning",
    ],
    "A tidy home without the Sunday scrub.",
    "Busy families and renters in Nettlewick.",
    "We send two cleaners with their own supplies, work to a written checklist and message you when the job is done.",
    "9 years trading. Insured up to $2 million. Every cleaner is background checked.",
    ["07:30", "17:30"],
    20,
  ],
  [
    "clean-02",
    "cleaning",
    "Brightwren Cleaners",
    "Marrowgate",
    206,
    101,
    "brightwren",
    ["Office cleaning", "Studio cleaning", "Window cleaning"],
    "Quiet, careful office cleaning.",
    "Small offices and studios around Marrowgate.",
    "We clean after hours with your own key code, so you start the day in a tidy room.",
    "6 years trading. Fully insured. Eco-certified products only.",
    ["06:00", "14:00"],
    15,
  ],
  [
    "clean-03",
    "cleaning",
    "Quillfeather Maid Service",
    "Ashkettle",
    206,
    102,
    "quillfeather",
    [
      "Regular maid service",
      "Spring cleaning",
      "Holiday-let turnovers",
      "Laundry and linens",
      "Carpet cleaning",
    ],
    "Your home, looking after itself.",
    "Holiday-let hosts and busy households in Ashkettle.",
    "You book a slot online, we confirm by text and the same maid comes each time.",
    "12 years trading. Insured. Same maid every visit.",
    ["08:00", "18:00"],
    25,
  ],
  [
    "clean-04",
    "cleaning",
    "Sorrel & Sage Cleaning Co.",
    "Pellowmere",
    206,
    103,
    "sorrelsage",
    [
      "Green cleaning",
      "Allergy-friendly cleaning",
      "Nursery and playroom cleaning",
      "Pet-hair cleaning",
    ],
    "Clean that is gentle on little lungs.",
    "Families with babies, allergies or pets in Pellowmere.",
    "We use fragrance-free plant-based products and tell you everything we used on the visit.",
    "5 years trading. Insured. Fragrance-free products on every job.",
    ["09:00", "16:00"],
    18,
  ],
  [
    "clean-05",
    "cleaning",
    "Hollowick Sparkle Crew",
    "Hollowick",
    206,
    104,
    "hollowicksparkle",
    ["End-of-tenancy cleaning", "Builders' clean", "Pressure washing"],
    "Handover-ready, every time.",
    "Landlords, letting agents and builders in Hollowick.",
    "A crew of three arrives with a checklist, finishes in one visit and sends photos for your inventory.",
    "8 years trading. Insured up to $5 million. Re-clean promise within 48 hours.",
    ["07:00", "19:00"],
    30,
  ],
  [
    "clean-06",
    "cleaning",
    "Larkspur Lane Cleaning",
    "Tarnbury Reach",
    206,
    105,
    "larkspurlane",
    [
      "Home cleaning",
      "Garden room and conservatory cleaning",
      "Gutter clearing",
      "Solar panel washing",
      "Upholstery cleaning",
    ],
    "Inside, outside, finished.",
    "Homeowners with larger properties around Tarnbury Reach.",
    "One visit covers the house, the glass and the outdoors, priced after a quick walk-through.",
    "14 years trading. Insured. Family run.",
    ["08:00", "17:00"],
    35,
  ],
  // legal
  [
    "legal-01",
    "legal",
    "Dunmarrow & Pike Solicitors",
    "Dunmarrow",
    312,
    110,
    "dunmarrowpike",
    [
      "Wills and probate",
      "Lasting powers of attorney",
      "Estate planning",
      "Trusts",
    ],
    "Plain advice for the people you leave behind.",
    "Families and older clients in Dunmarrow.",
    "A free fifteen minute call, then a fixed-fee quote in writing before we start.",
    "22 years in practice. Members of the Wills and Probate Society. Fixed fees.",
    ["09:00", "17:00"],
    40,
  ],
  [
    "legal-02",
    "legal",
    "Vessington Family Law",
    "Vessington",
    312,
    111,
    "vessingtonfamily",
    [
      "Divorce and separation",
      "Child arrangements",
      "Financial settlements",
      "Mediation",
    ],
    "Steady guidance through hard seasons.",
    "Parents and couples who are separating.",
    "We start with one conversation about what matters most, then agree a plan and a budget.",
    "15 years in family law. Resolution members. Fixed-fee first consultation.",
    ["09:00", "18:00"],
    50,
  ],
  [
    "legal-03",
    "legal",
    "Ostler Wren Legal",
    "Eddlescar",
    312,
    112,
    "ostlerwren",
    ["Commercial contracts", "Company formation", "Shareholder agreements"],
    "Contracts that read like they were written for you.",
    "Founders and small companies in Eddlescar.",
    "You get one named lawyer, answers within a working day and no hourly surprises.",
    "11 years in practice. Capped fees on every matter.",
    ["08:30", "17:30"],
    60,
  ],
  [
    "legal-04",
    "legal",
    "Corbel & Finch Employment Law",
    "Brindlecombe",
    312,
    113,
    "corbelfinch",
    [
      "Unfair dismissal",
      "Redundancy advice",
      "Settlement agreements",
      "Employment contracts",
      "Workplace disputes",
    ],
    "On your side of the table.",
    "Employees and small employers in Brindlecombe.",
    "We tell you in the first call whether you have a case, and what it would cost to pursue.",
    "18 years in employment law. No win, no fee on selected claims.",
    ["09:00", "17:30"],
    45,
  ],
  [
    "legal-05",
    "legal",
    "Marsh Quillon Property Law",
    "Oakenmere",
    312,
    114,
    "marshquillon",
    ["Buying and selling homes", "Remortgages", "Leasehold advice"],
    "Moving house, minus the mystery.",
    "First-time buyers and sellers in Oakenmere.",
    "Every client gets a tracker link showing where their purchase stands, updated as we work.",
    "13 years in conveyancing. Fixed fees. Lender panel approved.",
    ["09:00", "17:00"],
    35,
  ],
  [
    "legal-06",
    "legal",
    "Tansy Hale Estate Planning",
    "Sorrelby",
    312,
    115,
    "tansyhale",
    [
      "Wills",
      "Powers of attorney",
      "Care fee planning",
      "Probate administration",
    ],
    "A calm start to the paperwork nobody wants.",
    "Retirees and their families around Sorrelby.",
    "We visit you at home if you prefer, explain each document in plain words and keep copies safe.",
    "20 years in practice. Home visits included. Fixed fees.",
    ["10:00", "16:00"],
    30,
  ],
  // limousine
  [
    "limo-01",
    "limousine",
    "Gilded Lark Limousines",
    "Thistledown Quay",
    415,
    120,
    "gildedlark",
    ["Wedding cars", "Prom limousines", "Airport transfers", "Nights out"],
    "Arrive like the main event.",
    "Couples, prom groups and parties around Thistledown Quay.",
    "You pick the car, we send a quote with the date held, and the chauffeur arrives fifteen minutes early.",
    "10 years trading. Licensed and insured. Chauffeurs are background checked.",
    ["08:00", "23:00"],
    60,
  ],
  [
    "limo-02",
    "limousine",
    "Velvet Mallow Chauffeurs",
    "Wrenfield Cross",
    415,
    121,
    "velvetmallow",
    ["Corporate travel", "Airport transfers", "Roadshows", "Hotel transfers"],
    "On time, every time, in every suit.",
    "Businesses and visiting executives in Wrenfield Cross.",
    "We hold an account for your company, track every flight and bill once a month.",
    "7 years trading. Licensed. Flight tracking on every airport run.",
    ["05:00", "23:00"],
    80,
  ],
  [
    "limo-03",
    "limousine",
    "Kestrel Lane Chauffeur Hire",
    "Quillhaven",
    415,
    122,
    "kestrellane",
    [
      "Wedding cars",
      "Funeral cars",
      "Anniversary rides",
      "Day hire",
      "Vineyard tours",
    ],
    "Dignified travel for the days that matter.",
    "Families celebrating or mourning in Quillhaven.",
    "We listen first, plan the route with you and keep the driver in the background so the day stays yours.",
    "16 years trading. Licensed and insured. Family run.",
    ["07:00", "21:00"],
    70,
  ],
  [
    "limo-04",
    "limousine",
    "Pennywhistle Prestige Cars",
    "Larkwhistle",
    415,
    123,
    "pennywhistle",
    ["Vintage wedding cars", "Photo shoots", "Film and event hire"],
    "Classic cars with a chauffeur's manners.",
    "Couples and creatives who want something rare.",
    "Our three restored cars come with a driver, a ribbon of your choosing and a spare umbrella.",
    "9 years trading. Insured for hire and reward. Cars restored in-house.",
    ["09:00", "20:00"],
    50,
  ],
  [
    "limo-05",
    "limousine",
    "Saltmarsh Silver Cars",
    "Fennimore Bay",
    415,
    124,
    "saltmarshsilver",
    [
      "Airport transfers",
      "Cruise port transfers",
      "Long-distance rides",
      "Group minibus hire",
    ],
    "Door to departure lounge.",
    "Holidaymakers and cruise passengers in Fennimore Bay.",
    "Fixed prices quoted up front, a name board at arrivals and a bottle of water waiting.",
    "12 years trading. Licensed. Fixed prices with no surge.",
    ["04:00", "23:59"],
    90,
  ],
  [
    "limo-06",
    "limousine",
    "Ember & Oak Executive Travel",
    "Grimble Heath",
    415,
    125,
    "emberoak",
    [
      "Executive saloons",
      "Event shuttles",
      "Private day hire",
      "Courier-grade parcel runs",
      "Conference transfers",
    ],
    "Quiet cars for loud schedules.",
    "Event organisers and executives around Grimble Heath.",
    "You get one dispatcher on the phone, a live tracking link and a driver briefed on your schedule.",
    "11 years trading. Licensed and insured. Dedicated dispatcher.",
    ["06:00", "22:00"],
    75,
  ],
]

const RICHNESS = ["bare", "bare", "photos", "photos", "full", "full"]
const TRAY = ["skip", "answer", "skip", "answer", "skip", "answer"]

/** What the three answerers of an industry pick. Two pick the same, the third differs on layout. */
const PICKS = {
  cleaning: {
    palette: "lagoon",
    fonts: "outfit_figtree",
    layout: "split_arch__photo_cards",
    other: "wash__numbered_rows",
  },
  legal: {
    palette: "graphite",
    fonts: "newsreader_inter",
    layout: "text_led__practice_list",
    other: "split_frame__alternating",
  },
  limousine: {
    palette: "midnight",
    fonts: "cormorant_manrope",
    layout: "dark_center__fleet",
    other: "dark_center__alternating",
  },
}

const INDUSTRY_FACT = {
  cleaning: { name: "Cleaning and home services", category: "cleaning" },
  legal: { name: "Legal and consultancy", category: "legal" },
  limousine: { name: "Limousine and chauffeur hire", category: "chauffeur" },
}

const uuid = (n, i) =>
  `00000000-0000-4000-8000-${String(n).padStart(6, "0")}0${String(i).padStart(5, "0")}`

export const BUSINESSES = ENTRIES.map((e, at) => {
  const [
    id,
    industry,
    name,
    town,
    area,
    line,
    slug,
    offerings,
    tagline,
    audience,
    overview,
    proof,
    hours,
    radius_km,
  ] = e
  const within = at % 6
  return {
    id,
    industry,
    name,
    town,
    phone: `+1${area}5550${line}`,
    email: `hello@${slug}.example.com`,
    offerings,
    tagline,
    audience,
    overview,
    proof,
    hours,
    radius_km,
    richness: RICHNESS[within],
    tray: TRAY[within],
    /** Which of the industry's answerers this is: 0 and 1 pick alike, 2 differs on layout. */
    answerer: TRAY[within] === "answer" ? Math.floor(within / 2) : null,
  }
})

/** The stored facts an owner of this business would have stated, by key, in `FactValue`'s shapes. */
export function toFacts(b) {
  const number = Number(b.id.replace(/\D/g, ""))
  const photos = b.richness === "bare" ? 0 : 3
  const facts = [
    ["business.name", { name: b.name }],
    ["business.phone", { e164: b.phone }],
    ["business.email", { address: b.email }],
    ["business.industry", INDUSTRY_FACT[b.industry]],
    ["business.offerings", { items: b.offerings }],
    ["service_area.text", { text: `${b.town} and the villages around it` }],
  ]
  if (b.richness !== "bare") {
    facts.push(
      ["business.tagline", { tagline: b.tagline }],
      ["hours.weekday", { open: b.hours[0], close: b.hours[1] }]
    )
  }
  if (b.richness === "full") {
    facts.push(
      ["business.audience", { text: b.audience }],
      ["business.overview", { text: b.overview }],
      ["business.proof", { text: b.proof }],
      ["service_area.radius", { centre: b.town, radius_km: b.radius_km }]
    )
  }
  if (photos) {
    facts.push([
      "media.uploads",
      {
        items: Array.from({ length: photos }, (_, i) => ({
          id: uuid(
            number +
              (b.industry === "legal"
                ? 100
                : b.industry === "limousine"
                  ? 200
                  : 0),
            i + 1
          ),
          name: `${b.id}-photo-${i + 1}.jpg`,
          content_type: "image/jpeg",
          bytes: 180_000 + i * 1_000,
          alt: `${b.name}, photo ${i + 1}`,
        })),
      },
    ])
  }
  return facts.map(([key, value]) => ({ key, value }))
}

/** What the owner sends back from the design tray: `AskDesignOutput`. */
export function toTray(b) {
  if (b.tray === "skip") return { answers: {}, skip_all: true }
  const pick = PICKS[b.industry]
  return {
    skip_all: false,
    answers: {
      palette: { choice: pick.palette },
      fonts: { choice: pick.fonts },
      layout: { choice: b.answerer === 2 ? pick.other : pick.layout },
    },
  }
}
