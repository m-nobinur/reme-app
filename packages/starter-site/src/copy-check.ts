/**
 * The copy check `astro build` prints after every build (see
 * astro.config.mjs): one h1 a page, a title and a meta description of a
 * length search results show whole, none shared between pages, no em dash
 * and none of the stock phrases below. It warns and never fails the build: a
 * fact shown as given, such as a review, may carry any of them.
 *
 * Pure over the built HTML, so the Developer's rules can name the same list.
 */

/** Phrases that mark copy as filler. Matched case-insensitively at the start of a word. */
export const BANNED_PHRASES = [
  "elevate",
  "unlock",
  "seamless",
  "nestled",
  "testament",
  "vibrant",
  "look no further",
  "fast-paced world",
  "pride ourselves",
  "one-stop shop",
  "game-changer",
  "cutting-edge",
  "state-of-the-art",
  "top-notch",
  "unparalleled",
  "second to none",
  "delve",
  "embark",
  "tapestry",
  "rest assured",
  "hassle-free",
  "we've got you covered",
]

/** U+2014, by code so this file holds none. */
const EM_DASH = String.fromCharCode(0x2014)

const TITLE_CHARS = { min: 50, max: 60 }
const DESCRIPTION_CHARS = { min: 140, max: 165 }

type BuiltPage = { file: string; html: string }

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&#x27;": "'",
}
const decode = (text: string) =>
  text.replace(/&(?:amp|lt|gt|quot|#39|#x27);/g, (m) => ENTITIES[m] ?? m)

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const BANNED = BANNED_PHRASES.map((phrase) => ({
  phrase,
  pattern: new RegExp(
    `\\b${escapeRegExp(phrase).replace(/[- ]/g, "[- ]")}`,
    "i"
  ),
}))

/** What a visitor reads on a page, the title and the description included. */
const textOf = (html: string) =>
  decode(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<meta\b[^>]*\bcontent="([^"]*)"[^>]*>/gi, " $1 ")
      .replace(/<[^>]+>/g, " ")
  )

/** One line per finding, each naming the page; empty when the copy passes. */
export function copyFindings(pages: readonly BuiltPage[]): string[] {
  const found: string[] = []
  const seen = {
    title: new Map<string, string>(),
    description: new Map<string, string>(),
  }
  for (const { file, html } of pages) {
    const say = (line: string) => found.push(`${file}: ${line}`)
    const indexed = !/<meta name="robots" content="noindex"/.test(html)
    const h1s = html.match(/<h1[\s>]/g)?.length ?? 0
    if (indexed && h1s !== 1)
      say(`has ${h1s} h1 elements; a page has exactly one`)

    const title = decode(
      html.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ""
    ).trim()
    const description = decode(
      html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? ""
    ).trim()
    if (indexed) {
      for (const [name, value, range, aim] of [
        ["title", title, TITLE_CHARS, "50 to 60"],
        ["meta description", description, DESCRIPTION_CHARS, "140 to 160"],
      ] as const) {
        if (!value) say(`has no ${name}`)
        else if (value.length < range.min || value.length > range.max)
          say(`${name} is ${value.length} characters; write ${aim}`)
      }
      for (const [key, value] of [
        ["title", title],
        ["description", description],
      ] as const) {
        const other = value && seen[key].get(value)
        if (other) say(`shares its ${key} with ${other}`)
        else if (value) seen[key].set(value, file)
      }
    }

    const text = textOf(html)
    if (text.includes(EM_DASH))
      say("has an em dash; use a comma, a colon or two sentences")
    for (const { phrase, pattern } of BANNED) {
      if (pattern.test(text))
        say(`says "${phrase}"; say what the business does instead`)
    }
  }
  return found
}
