/**
 * The colour card's arithmetic: reading a colour code the owner typed or
 * picked, whether white text reads on it, and which options a Show others
 * press brings in. The contrast maths is WCAG 2.2's, as the starter site's
 * `brand.ts` does it, so the card warns about the colours the site will
 * have to darken.
 */

type Rgb = [number, number, number]

const WHITE: Rgb = [255, 255, 255]
const BLACK: Rgb = [0, 0, 0]

/** WCAG AA for body text. */
export const AA = 4.5

/** `#rrggbb`, lower case, from `#rgb` or `#rrggbb` in any case; null otherwise. */
export function hexColour(text: string): string | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim())
  if (!match) return null
  const digits = match[1] as string
  const full =
    digits.length === 3
      ? [...digits].map((digit) => digit + digit).join("")
      : digits
  return `#${full.toLowerCase()}`
}

const rgb = (hex: string): Rgb => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
]

const channel = (value: number) => {
  const part = value / 255
  return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4
}
const luminance = ([r, g, b]: Rgb) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)

const ratio = (a: Rgb, b: Rgb) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ]
  return (light + 0.05) / (dark + 0.05)
}

const toHex = (value: Rgb) =>
  `#${value.map((part) => part.toString(16).padStart(2, "0")).join("")}`

/** The contrast of white text on a `#rrggbb` colour, 1 to 21. */
export const whiteContrast = (hex: string) => ratio(WHITE, rgb(hex))

/** White or black, whichever reads better on a `#rrggbb` colour. */
export const textOn = (hex: string) =>
  toHex(whiteContrast(hex) >= ratio(BLACK, rgb(hex)) ? WHITE : BLACK)

function shuffled<T>(list: readonly T[], random: () => number): T[] {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j] as T, out[i] as T]
  }
  return out
}

/**
 * The options a Show others press brings in: as many as are shown, at
 * random from those not seen yet this round. When too few are left, it
 * shows the last of them topped up from the rest and starts a new round,
 * so no option repeats before every one has been shown.
 */
export function nextShown(
  ids: readonly string[],
  shown: readonly string[],
  seen: readonly string[],
  random: () => number = Math.random
): { shown: string[]; seen: string[] } {
  const size = shown.length
  const unseen = shuffled(
    ids.filter((id) => !seen.includes(id)),
    random
  )
  if (unseen.length >= size) {
    const next = unseen.slice(0, size)
    return { shown: next, seen: [...seen, ...next] }
  }
  const rest = shuffled(
    ids.filter((id) => !unseen.includes(id) && !shown.includes(id)),
    random
  )
  const next = [...unseen, ...rest, ...shuffled(shown, random)].slice(0, size)
  return { shown: next, seen: next }
}

/** `hex` moved `t` (0 to 1) of the way to `end`, a channel value: 255 for light, 0 for dark. */
export const shade = (hex: string, end: number, t: number) =>
  toHex(rgb(hex).map((part) => Math.round(part + (end - part) * t)) as Rgb)
