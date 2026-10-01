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
 *     the page under this text is white.
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

/**
 * The ramp as one CSS rule for the page head, or an empty string. `html:root`,
 * not `:root`: the linked stylesheet comes after this rule in the built page
 * and declares the defaults on `:root`, which would win a tie.
 */
export function brandTheme(value: string): string {
  const ramp = brandRamp(value)
  if (!ramp) return ""
  return `html:root{--brand:${ramp.brand};--brand-foreground:${ramp.foreground};--brand-text:${ramp.text}}`
}
