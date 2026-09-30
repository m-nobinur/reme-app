import type { IndustryId } from "@workspace/contracts"

/**
 * Words that place an owner's own description of their business in one of
 * the industry list's categories. The first category with a matching word
 * wins, so the more specific ones come first and retail, whose "shop" and
 * "store" turn up everywhere, comes last.
 */
export const INDUSTRY_WORDS: [IndustryId, string[]][] = [
  [
    "automotive",
    ["garage", "mot", "car wash", "valeting", "valet", "detailing", "mechanic"],
  ],
  ["chauffeur", ["limo", "limousine", "taxi", "chauffeur", "cab", "minicab"]],
  [
    "trades",
    [
      "plumber",
      "plumbing",
      "electrician",
      "roofer",
      "roofing",
      "builder",
      "joiner",
      "carpenter",
      "landscaper",
      "landscaping",
      "handyman",
      "painter",
      "decorator",
    ],
  ],
  [
    "legal",
    [
      "solicitor",
      "lawyer",
      "law",
      "legal",
      "accountant",
      "accountancy",
      "bookkeeper",
      "consultant",
      "consultancy",
      "advisor",
      "adviser",
    ],
  ],
  ["cleaning", ["maid", "cleaner", "cleaning"]],
  [
    "beauty",
    ["barber", "hairdresser", "nail", "lash", "spa", "salon", "beauty"],
  ],
  [
    "health",
    [
      "physio",
      "physiotherapist",
      "physiotherapy",
      "dentist",
      "dental",
      "clinic",
      "therapist",
      "osteopath",
      "chiropractor",
      "yoga",
      "pilates",
      "gym",
      "personal trainer",
      "personal training",
    ],
  ],
  [
    "food",
    [
      "cafe",
      "coffee shop",
      "restaurant",
      "caterer",
      "catering",
      "bakery",
      "bar",
      "pub",
      "food truck",
      "takeaway",
    ],
  ],
  ["property", ["estate agent", "letting", "property manager"]],
  ["education", ["tutor", "tutoring", "school", "lesson", "training", "coach"]],
  [
    "events",
    ["dj", "photographer", "florist", "wedding planner", "event", "venue"],
  ],
  ["retail", ["shop", "boutique", "store", "online shop"]],
]

/** `word` as a whole-word pattern that also takes its plural. */
const whole = (word: string) =>
  `\\b${word.replace(/y$/, "(?:y|ie)")}(?:s|es)?\\b`

const PATTERNS = INDUSTRY_WORDS.map(
  ([id, words]) =>
    [id, new RegExp(words.map(whole).join("|"), "i")] as [IndustryId, RegExp]
)

/** The category an owner's own words fall in, or null when none fits. */
export function industryOf(words: string): IndustryId | null {
  const plain = words.normalize("NFD").replace(/\p{M}/gu, "")
  return PATTERNS.find(([, pattern]) => pattern.test(plain))?.[0] ?? null
}
