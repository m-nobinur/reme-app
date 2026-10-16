import { DesignDirection, type IndustryId } from "@workspace/contracts"
import { STARTER_FILES } from "./seed.ts"

/**
 * The design directions library (ADR-038): VS's `src/directions.json`, which
 * reaches this Worker through the seed glob, so the day the file lands in the
 * starter it is the library with no change here. Until then the two entries
 * below stand in, so the planner and its tests have something real to pick.
 * Either way every entry is parsed by CT1's `DesignDirection`, and a file that
 * does not parse fails the Worker at load rather than a build at plan time.
 */
const DIRECTIONS_FILE = "src/directions.json"

/** Two of VS6's starting set, as its table writes them. */
export const STAND_IN_DIRECTIONS: readonly DesignDirection[] = [
  {
    id: "calm_daylight",
    label: "Calm daylight",
    industries: ["cleaning", "health", "beauty"],
    fonts: "outfit_figtree",
    palettes: ["forest", "sage", "mint"],
    hero: "wash",
    services: "photo_cards",
    steps: "circles",
    faq: "split",
    cta: "solid",
    radius: "soft",
    bands: "one_dark",
    ornament: "pill captions",
    image_style:
      "Empty sunlit interiors, soft daylight, one prop in the brand hue.",
    voice: "Warm and plain, about rooms and the time it gives back.",
  },
  {
    id: "counsel",
    label: "Counsel",
    industries: ["legal", "property"],
    fonts: "newsreader_inter",
    palettes: ["midnight", "graphite", "classic_blue"],
    hero: "text_led",
    services: "practice_list",
    steps: "timeline",
    faq: "stacked",
    cta: "solid",
    radius: "square",
    bands: "one_dark",
    ornament: "rules and numerals",
    image_style:
      "Desks, documents and building exteriors in a cool neutral grade.",
    voice: "Calm and exact. Short sentences, no promises about outcomes.",
  },
]

/**
 * The library from the file's text: an array, or an object holding one under
 * `directions` (the shape `recipes.json` uses, with a `_` note beside it).
 * Absent text is the stand-in pair.
 */
export function loadDirections(raw: string | undefined): DesignDirection[] {
  if (raw === undefined) return [...STAND_IN_DIRECTIONS]
  const json = JSON.parse(raw) as unknown
  const list = Array.isArray(json)
    ? json
    : (json as { directions?: unknown }).directions
  return DesignDirection.array().min(1).parse(list)
}

export const DIRECTIONS = loadDirections(STARTER_FILES[DIRECTIONS_FILE])

/** The directions written for an industry, or the whole library when none is. */
export function directionsFor(
  industry: IndustryId | undefined,
  library: readonly DesignDirection[] = DIRECTIONS
): readonly DesignDirection[] {
  const fit = library.filter((d) => industry && d.industries.includes(industry))
  return fit.length > 0 ? fit : library
}

/** One prompt line per direction, for the planner's and the Developer's stable prefix. */
export const directionLine = (d: DesignDirection) =>
  `- ${d.id} (${d.label}; for ${d.industries.join(", ")}): fonts ${d.fonts}; palettes ${d.palettes.join(", ")}; hero ${d.hero}, services ${d.services}, steps ${d.steps}, faq ${d.faq}, cta ${d.cta}; radius ${d.radius}; bands ${d.bands}; ornament: ${d.ornament}. Photos: ${d.image_style} Voice: ${d.voice}`
