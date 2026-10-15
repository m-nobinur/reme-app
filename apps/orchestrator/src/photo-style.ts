import type { ImageSlot, IndustryId } from "@workspace/contracts"

/**
 * The house photo style: what every generated photo shares, whatever the
 * direction. Taken from spotless-templates.lovable.app (studied 2026-10-15):
 * editorial interiors in soft window light, white walls, light oak and soft
 * grey stone, the brand's green carried by plants, nobody in frame, straight
 * verticals, a 35 to 50 mm look, tidy and sparse. Our photos that read as
 * worse had the opposite: a saturated HDR grade, a blue cloth placed in every
 * frame for the "brand prop", crushed film blacks and warped appliances.
 * The direction's own `image_style` sets the mood on top; where the two
 * disagree (a saturated or high-contrast direction), this wins.
 */
export const HOUSE_STYLE =
  "Editorial photograph for an architecture and lifestyle magazine, full-frame camera, 35 to 50 mm lens, eye level or slightly above, straight vertical lines. " +
  "Soft natural daylight (window light indoors, bright overcast or low sun outdoors), high-key but never blown out, gentle contrast, true-to-life colour, light depth of field. " +
  "Minimal tidy styling, few objects, every surface clean. Not CGI or a 3D render, no HDR, no oversaturation, no fisheye, no vignette, no heavy grain."

/** The places a trade's photos are set in, which the prompt writer picks its scenes from. */
const SETTING: Record<IndustryId, string> = {
  cleaning:
    "homes and offices just cleaned: white walls, light oak, soft grey stone, linen, a window onto greenery",
  chauffeur:
    "a clean dark car at a hotel or venue entrance, leather and stitching details, polished paint, calm evening or daylight",
  legal:
    "a calm modern office: an oak desk with ordered papers, bookshelves, a meeting table in daylight",
  health:
    "a bright treatment or consulting room: pale wood, white linen, equipment at rest",
  beauty:
    "a bright salon or treatment room: a styling chair or treatment bed, a mirror, warm wood, neat unlabelled products",
  food: "food and rooms in daylight: a plated dish, a counter, a dining room set before service",
  trades:
    "finished work in place: a fitted kitchen, a new bathroom, a laid patio, a planted border, a tiled floor; tools at rest at most",
  automotive:
    "a clean, well-lit workshop or a car detail: a wheel, an engine bay, a seat; tools racked neatly",
  property: "bright staged rooms and well-kept exteriors, wide but undistorted",
  education:
    "a calm study or teaching room: a table with books and a laptop, a blank whiteboard, daylight",
  events:
    "a venue or table set before guests arrive: linen, glassware, flowers, warm light",
  retail:
    "products arranged on a clean surface or a tidy shop interior, nothing readable on a label",
}
const SETTING_DEFAULT =
  "the finished result of the service, in a clean, real place"

export const settingFor = (industry: string) =>
  SETTING[industry as IndustryId] ?? SETTING_DEFAULT

/** What a slot's crop asks of the frame, by the box it renders in. */
export const FRAMING = {
  hero: "An establishing view of the whole space or finished result, wide enough to read the place, one clear focal area. Nothing important in the outer eighth of the frame, which the layout may crop.",
  card: "A closer view of one area or detail that says this service at a glance, three-quarter or straight-on, the subject filling the middle of the frame and the background softly out of focus. Nothing important at the edges.",
  band: "A calm, low-detail wide view, such as a wall in window light, a tidy worktop or foliage, that reads as texture under a colour wash. No focal object.",
} as const

export const framingOf = (section: ImageSlot["section"]) =>
  section === "hero"
    ? FRAMING.hero
    : section === "cta_band"
      ? FRAMING.band
      : FRAMING.card

/** The rules the prompt writer follows for every set, beyond the scene list. */
export const STYLE_GUIDE =
  "The photos follow a fixed house style (light, lens, grade), added to every prompt for you; do not restate camera settings. " +
  "Shoot the set like one photographer on one day in one kind of place: the same light, materials and palette in every frame. " +
  "Colour: mostly white, warm natural wood and soft neutrals; the brand colour appears in one or two natural or soft-furnishing details (a plant, a cushion, a throw, a vase, a chair), never in a cleaning product, a cloth or a tool, and never as a colour cast. " +
  "Prefer simple, well-known shapes (a worktop, a sink, a sofa, a bed, a desk, a doorway) over mechanisms image models draw wrong: oven doors, hinges, taps seen up close, ladders, hands holding tools. " +
  "No people. If a scene needs one, show hands at work from the side, never a face. "

const HUES = "red orange ochre green teal blue violet plum red".split(" ")
/** Each hue's upper bound in degrees, in `HUES` order. */
const HUE_EDGES = [15, 40, 65, 160, 195, 250, 290, 345, 361]

/**
 * A hex colour in words an image model can paint: "muted green".
 * Hue buckets by HSL, with lightness and saturation as the adjective.
 */
export function colourName(hex: string): string {
  const n = Number.parseInt(hex.replace("#", ""), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(
    (c) => c / 255
  ) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  if (s < 0.12)
    return l < 0.25 ? "charcoal" : l > 0.75 ? "pale grey" : "mid grey"
  const h =
    max === r
      ? (((g - b) / d + 6) % 6) * 60
      : max === g
        ? ((b - r) / d + 2) * 60
        : ((r - g) / d + 4) * 60
  // One string, split: the colour lint reads a lone "red" as a hard-coded CSS colour.
  const hue = HUES[HUE_EDGES.findIndex((edge) => h < edge)] as string
  const tone = l < 0.3 ? "deep " : l > 0.7 ? "pale " : ""
  return `${s < 0.35 ? "muted " : ""}${tone}${hue}`.trim()
}

/** The brand colour named in the brief's palette words, as `photo-step.ts` writes them. */
export function accentOf(palette: string): string | null {
  const hex = /(?:primary|brand colour) (#[0-9a-f]{6})/i.exec(palette)?.[1]
  return hex ? colourName(hex) : null
}

/** The house style and the accent, the part of every draw prompt that never changes within a set. */
export const houseLine = (palette: string) => {
  const accent = accentOf(palette)
  return `${HOUSE_STYLE}${
    accent
      ? ` Palette: white, light wood and soft neutrals, with ${accent} only in a plant or a soft-furnishing detail.`
      : ""
  }`
}
