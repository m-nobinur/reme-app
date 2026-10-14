/**
 * The font pairs a site can wear, self-hosted from the @fontsource packages
 * the sandbox image carries, so a build needs no network and a page loads
 * nothing from a font CDN.
 *
 * The pairs, the ids and the legacy map are the contract's `fonts.json` and
 * `LEGACY_FONT_PAIR`; this file copies them because it imports nothing, and
 * the starter's tests fail when the copies drift. Latin subset, woff2 only.
 */

type Face = { family: string; weights: number[] }
export type FontPair = { display: Face & { italic: boolean }; body: Face }

export const PAIRS: Record<string, FontPair> = {
  outfit_figtree: {
    display: { family: "Outfit", weights: [500, 600], italic: false },
    body: { family: "Figtree", weights: [400, 500] },
  },
  dmsans_fraunces: {
    display: { family: "Fraunces", weights: [500], italic: true },
    body: { family: "DM Sans", weights: [400, 500] },
  },
  instrument_worksans: {
    display: { family: "Instrument Serif", weights: [400], italic: false },
    body: { family: "Work Sans", weights: [400, 500] },
  },
  sora_manrope: {
    display: { family: "Sora", weights: [500, 600], italic: false },
    body: { family: "Manrope", weights: [400, 500] },
  },
  syne_jakarta: {
    display: { family: "Syne", weights: [600], italic: false },
    body: { family: "Plus Jakarta Sans", weights: [400, 500] },
  },
  newsreader_inter: {
    display: { family: "Newsreader", weights: [500], italic: false },
    body: { family: "Inter", weights: [400, 500] },
  },
  cormorant_manrope: {
    display: { family: "Cormorant Garamond", weights: [500], italic: true },
    body: { family: "Manrope", weights: [400, 500] },
  },
  fraunces_figtree: {
    display: { family: "Fraunces", weights: [600], italic: false },
    body: { family: "Figtree", weights: [400] },
  },
}

/** The ids stored facts held before pairs, and the pair each means now. */
export const LEGACY: Record<string, string> = {
  clean_sans: "outfit_figtree",
  classic_serif: "newsreader_inter",
  soft_rounded: "fraunces_figtree",
}

/** The pair a `site.font` value names, directly or by its legacy id. */
export function pairOf(value: string): FontPair | undefined {
  const id = value.trim()
  const key = Object.hasOwn(PAIRS, id) ? id : LEGACY[id]
  return key === undefined ? undefined : PAIRS[key]
}

/** The page properties the two faces are written to; theme.css reads them. */
export const DISPLAY_VAR = "--face-display"
export const BODY_VAR = "--face-body"

const SERIF = new Set([
  "Fraunces",
  "Instrument Serif",
  "Newsreader",
  "Cormorant Garamond",
])

const slug = (family: string) => family.toLowerCase().replaceAll(" ", "-")

/** The package-relative path of one woff2 file. */
const file = (family: string, weight: number, style: "normal" | "italic") =>
  `@fontsource/${slug(family)}/files/${slug(family)}-latin-${weight}-${style}.woff2`

/** Every woff2 file a pair can load. The italic display only loads if used. */
export function filesOf(pair: FontPair): string[] {
  const { display, body } = pair
  return [
    ...display.weights.flatMap((weight) => [
      file(display.family, weight, "normal"),
      ...(display.italic ? [file(display.family, weight, "italic")] : []),
    ]),
    ...body.weights.map((weight) => file(body.family, weight, "normal")),
  ]
}

/**
 * The pair as Astro font families for its local provider, which adds the
 * metric-matched fallback faces and the preload data. Empty for no pair, so
 * a site with no font choice ships no font file.
 */
export function familiesOf(pair: FontPair | undefined) {
  if (!pair) return []
  const { display, body } = pair
  const family = (
    face: Face,
    cssVariable: string,
    styles: ("normal" | "italic")[]
  ) => ({
    name: face.family,
    cssVariable,
    display: "swap" as const,
    fallbacks: [SERIF.has(face.family) ? "serif" : "sans-serif"],
    options: {
      variants: face.weights.flatMap((weight) =>
        styles.map((style) => ({
          weight,
          style,
          src: [file(face.family, weight, style)] as [string],
        }))
      ),
    },
  })
  return [
    family(
      display,
      DISPLAY_VAR,
      display.italic ? ["normal", "italic"] : ["normal"]
    ),
    family(body, BODY_VAR, ["normal"]),
  ]
}

/**
 * One rule for the page head: the display weight of the pair, and the italic
 * for a headline's accented word when the pair draws it in one. The weight
 * beats theme.css's default, as an owner's choice always has.
 */
export function fontTheme(pair: FontPair | undefined): string {
  if (!pair) return ""
  const italic = pair.display.italic ? ";--accent-style:italic" : ""
  return `html:root{--display-weight:${pair.display.weights[0]}${italic}}`
}
