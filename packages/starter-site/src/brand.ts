/**
 * The owner's brand colour, turned into a theme at build time.
 *
 * `site.brandColor` is one hex string the owner chose. CSS alone cannot say
 * whether text on that colour is readable, so the ramp is derived here, where
 * the contrast can be measured, and written into the page head as three custom
 * properties that override the defaults in styles/theme.css. Everything else
 * mixes off them.
 *
 * Two pairs have to hold at WCAG AA, 4.5:1:
 *   --brand-foreground on --brand, which is black or white, whichever wins.
 *     One of them always reaches 4.58:1 or better, whatever the colour.
 *   --brand-text on the page, which is the colour darkened in steps until it
 *     reaches the ratio. Darkening only, because the starter renders light and
 *     the page under this text is white. A preset's primary already holds it
 *     on the page and on its tint, so `brandTheme` passes it through.
 *
 * `paletteFromBrand` goes further for the "your own colour" path: it derives
 * all six palette roles (paper, ink, primary, tint, accent, line) from the one
 * hex, neutrals leaning toward its hue, and darkens `primary` and `ink` until
 * the four pairs `PALETTE_AA_PAIRS` names in the contracts hold at 4.5:1. The
 * brand test reads that list from the contract; this file cannot import it.
 *
 * `site.palette` skips the derivation: it carries a preset's six roles, which
 * `paletteOf` reads and `brandTheme` writes as they are.
 *
 * A colour that is not a hex string returns nothing and the site keeps the
 * default theme. The file imports nothing, so it builds in the sandbox.
 */
type Rgb = [number, number, number]

/** The page the derived text sits on. Light only, as the starter renders. */
const SURFACE: Rgb = [255, 255, 255]
const WHITE: Rgb = [255, 255, 255]
const BLACK: Rgb = [0, 0, 0]
const AA = 4.5

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

function parse(value: string): Rgb | undefined {
  const match = HEX.exec(value.trim())
  if (!match) return undefined
  const digits = match[1] as string
  const full =
    digits.length === 3
      ? digits
          .split("")
          .map((d) => d + d)
          .join("")
      : digits
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ]
}

// WCAG 2.2 relative luminance, sRGB.
const channel = (value: number) => {
  const part = value / 255
  return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4
}
const luminance = (rgb: Rgb) =>
  0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])

function ratio(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ]
  return (light + 0.05) / (dark + 0.05)
}

/** The WCAG contrast ratio between two hex colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [first, second] = [parse(a), parse(b)]
  if (!first || !second) throw new Error(`not a hex colour: ${a} or ${b}`)
  return ratio(first, second)
}

const toHex = (rgb: Rgb) =>
  `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`

/** The colour darkened a tenth at a time until it is readable on `on`. */
function readable(rgb: Rgb, on: Rgb, target: number): Rgb {
  let out = rgb
  for (let step = 0; step < 24 && ratio(out, on) < target; step++) {
    out = out.map((value) => Math.round(value * 0.9)) as Rgb
  }
  return out
}

// Hue and saturation of an sRGB colour, 0 to 1 (HSL).
function hueSat(rgb: Rgb): [number, number] {
  const [r, g, b] = rgb.map((v) => v / 255) as Rgb
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d === 0) return [0, 0]
  const l = (max + min) / 2
  const s = d / (1 - Math.abs(2 * l - 1))
  const h =
    max === r
      ? ((g - b) / d) % 6
      : max === g
        ? (b - r) / d + 2
        : (r - g) / d + 4
  return [(h / 6 + 1) % 1, s]
}

function hsl(h: number, s: number, l: number): Rgb {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return [f(0), f(8), f(4)]
}

export type BrandPalette = {
  paper: string
  ink: string
  primary: string
  tint: string
  accent: string
  line: string
}

/**
 * The six roles from one brand colour, or nothing when it is not a hex colour.
 * `accent` is the owner's colour as chosen, for marks and underlines, which
 * carry no contrast rule.
 */
export function paletteFromBrand(value: string): BrandPalette | undefined {
  const brand = parse(value)
  if (!brand) return undefined
  const [h, s] = hueSat(brand)
  const paper = hsl(h, Math.min(s, 0.5) * 0.5, 0.975)
  const tint = hsl(h, Math.min(s, 0.45) * 0.7, 0.91)
  const line = hsl(h, Math.min(s, 0.45) * 0.5, 0.84)
  const ink = readable(hsl(h, Math.min(s, 0.4) * 0.6, 0.1), tint, AA)
  return {
    paper: toHex(paper),
    ink: toHex(ink),
    // Darkened for the tint, the darker ground it sits on, so it reads on both.
    primary: toHex(readable(brand, tint, AA)),
    tint: toHex(tint),
    accent: toHex(brand),
    line: toHex(line),
  }
}

export type BrandRamp = { brand: string; foreground: string; text: string }

/** The three derived colours, or nothing when the value is not a hex colour. */
export function brandRamp(value: string): BrandRamp | undefined {
  const brand = parse(value)
  if (!brand) return undefined
  return {
    brand: toHex(brand),
    foreground: toHex(
      ratio(WHITE, brand) >= ratio(BLACK, brand) ? WHITE : BLACK
    ),
    text: toHex(readable(brand, SURFACE, AA)),
  }
}

const ROLES = ["paper", "ink", "primary", "tint", "accent", "line"] as const

/**
 * Secondary text: the ink eased toward the paper as far as AA on the tint
 * allows, the darker of the two grounds it sits on. The shared grey of
 * tokens.css is measured against a white page, not a palette's tint.
 */
export function mutedOf(palette: BrandPalette): string {
  const [ink, paper, tint] = [palette.ink, palette.paper, palette.tint].map(
    parse
  ) as [Rgb, Rgb, Rgb]
  for (let step = 9; step > 0; step--) {
    const mix = ink.map((v, i) =>
      Math.round(v + ((paper[i] as number) - v) * step * 0.05)
    ) as Rgb
    if (ratio(mix, tint) >= AA + 0.1 && ratio(mix, paper) >= AA + 0.1)
      return toHex(mix)
  }
  return palette.ink
}

/**
 * The six roles a `site.palette` value names, as `paper:#f7faf9 ink:#13201a
 * ...` in any order, or nothing unless all six are there as hex colours. A
 * preset's roles already hold the AA pairs, so they are taken as given.
 */
export function paletteOf(value: string): BrandPalette | undefined {
  const found = new Map(
    Array.from(
      value.matchAll(
        /\b(paper|ink|primary|tint|accent|line):\s*(#[0-9a-fA-F]{6})\b/g
      ),
      (match) => [match[1], (match[2] as string).toLowerCase()] as const
    )
  )
  return ROLES.every((role) => found.has(role))
    ? (Object.fromEntries(found) as BrandPalette)
    : undefined
}

/**
 * The theme as one CSS rule for the page head, or an empty string: from the
 * palette's six roles when `palette` has them, else derived from the one
 * brand colour. `html:root`, not `:root`: the linked stylesheet comes after
 * this rule in the built page and declares the defaults on `:root`, which
 * would win a tie.
 */
export function brandTheme(value: string, palette = ""): string {
  const roles = paletteOf(palette)
  // A preset's paper reads on its primary (an AA pair), so it is the label.
  const ramp = roles
    ? { brand: roles.primary, foreground: roles.paper }
    : brandRamp(value)
  const p = roles ?? paletteFromBrand(value)
  if (!ramp || !p) return ""
  // A palette whose paper is darker than its ink (After dark) is a dark page:
  // the stylesheet reads --ink as the dark surface and --paper as the light
  // text and pills on it, so the two swap names and the page keeps its logic.
  const paper = parse(p.paper) as Rgb
  const dark =
    ratio(paper, WHITE) > ratio(paper, BLACK)
      ? `;--ink:${p.paper};--paper:${p.ink};color-scheme:dark`
      : ""
  return `html:root{--brand:${ramp.brand};--brand-foreground:${ramp.foreground};--brand-text:${p.primary};--background:${p.paper};--foreground:${p.ink};--muted-foreground:${mutedOf(p)};--role-tint:${p.tint};--role-line:${p.line};--role-accent:${p.accent}${dark}}`
}
