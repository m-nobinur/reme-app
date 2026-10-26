import type { PaletteRoles, PaletteStops } from "@workspace/contracts"

/**
 * Stops of a logo or picture palette moved until `PALETTE_AA_PAIRS` hold, so
 * the swatches the owner picks are the colours the site is built in.
 */

type Rgb = [number, number, number]
const BLACK: Rgb = [0, 0, 0]
export const WHITE: Rgb = [255, 255, 255]

export const rgbOf = (hex: string): Rgb =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb
export const hexOf = (rgb: Rgb) =>
  `#${rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`

const luminance = (rgb: Rgb) =>
  rgb
    .map((c) => c / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * ([0.2126, 0.7152, 0.0722][i] as number), 0)

export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ]
  return (hi + 0.05) / (lo + 0.05)
}

const AA = 4.5

/** `from` moved `t` (0 to 1) of the way to `end`, in whole channels, as the hex will be. */
const mix = (from: Rgb, end: Rgb, t: number) =>
  from.map((v, i) => Math.round(v + ((end[i] as number) - v) * t)) as Rgb

function towards(from: Rgb, end: Rgb, passes: (c: Rgb) => boolean): Rgb {
  for (let t = 0; t <= 1; t += 0.02) {
    const c = mix(from, end, t)
    if (passes(c)) return c
  }
  return end
}

/**
 * Each stop moved only as far as AA needs; paper on primary also passes,
 * since it is a button's label.
 */
export function readableStops(stops: PaletteStops): PaletteStops {
  const paper = rgbOf(stops.paper)
  const far = contrast(paper, BLACK) >= contrast(paper, WHITE) ? BLACK : WHITE
  const ink = towards(rgbOf(stops.ink), far, (c) => contrast(c, paper) >= AA)
  const tint = towards(rgbOf(stops.tint), paper, (c) => contrast(c, ink) >= AA)
  const primary = towards(
    rgbOf(stops.primary),
    far,
    (c) => contrast(c, paper) >= AA && contrast(c, tint) >= AA
  )
  return {
    paper: stops.paper,
    tint: hexOf(tint),
    primary: hexOf(primary),
    ink: hexOf(ink),
  }
}

/** The accent reuses primary, which already reads at AA. */
export function paletteRoles(stops: PaletteStops): PaletteRoles {
  const { paper, tint, primary, ink } = readableStops(stops)
  return {
    paper,
    ink,
    primary,
    tint,
    accent: primary,
    line: hexOf(mix(rgbOf(paper), rgbOf(ink), 0.16)),
  }
}
