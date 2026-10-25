import { PLAN_DOING_MAX } from "@workspace/contracts"

/**
 * A thought's heading, as the providers stream it: bold, then a line break
 * (Gemini's `reasoning.text` opens each thought so, OpenAI's summaries
 * their first). Measured 2026-10-26.
 */
const HEADING = /(?:^|[\n.!?])\s*\*\*([^*\n]+)\*\*[ \t]*\n/g

/** Enough to hold one heading not yet closed. */
const TAIL = 200

/** The line changes at most this often, so it never flickers. */
const GAP_MS = 1_000

/**
 * Anything the owner should not read: code, names in code, ids, paths,
 * URLs, dashes as punctuation, and the words of how the assistant is built.
 */
const INTERNAL = [
  /[`{}[\]<>_\\/|=#@$~^–—]|\s-\s|https?:|www\.|\d{3,}/,
  /\b[a-z]+[A-Z]|[A-Z][a-z]+[A-Z]/,
  /\b(?:tools?|system|prompts?|json|api|schema|ids?|uuid|users?|agents?|developer|jev|instructions?)\b/i,
]

const CALENDAR =
  /^(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day|^(?:January|February|March|April|June|July|August|September|October|November|December)\b/

/** "Prioritizing" as "prioritising"; "size", "prize", "seize" and "capsize" stay. */
const british = (text: string) =>
  text
    .replace(/\b(\w{3,}?)(?<!caps)iz(e|es|ed|ing|ation|ations)\b/g, "$1is$2")
    .replace(/\banalyz(e|es|ed|ing)\b/g, "analys$1")

/**
 * A heading as the owner's waiting line: plain, sentence case, British, at
 * most `PLAN_DOING_MAX` characters, or null when it says anything internal.
 */
export function thoughtLine(heading: string): string | null {
  const text = heading
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[:.…]+$/, "")
  if (text.length < 3 || INTERNAL.some((pattern) => pattern.test(text))) {
    return null
  }
  // Gemini writes Title Case; a word in capitals, a day and a month keep it.
  const words = text
    .split(" ")
    .map((word, i) =>
      i > 0 && /^[A-Z][a-z]+(['’]s)?$/.test(word) && !CALENDAR.test(word)
        ? word.toLowerCase()
        : word
    )
  const line = british(words.join(" "))
  const cased = line.charAt(0).toUpperCase() + line.slice(1)
  return cased.length <= PLAN_DOING_MAX ? cased : null
}

/**
 * Reads a call's reasoning deltas and sends the line for each new heading,
 * never the reasoning itself. A heading that cleans to nothing keeps the
 * one before; one closer than `GAP_MS` to the last waits for the next delta.
 */
export function thoughtHeadings(
  send: (line: string) => void,
  now: () => number = Date.now
) {
  let rest = ""
  let latest: string | null = null
  let sent: string | null = null
  let at = Number.NEGATIVE_INFINITY
  return (delta: string) => {
    rest += delta
    let end = 0
    for (const match of rest.matchAll(HEADING)) {
      latest = thoughtLine(match[1] ?? "") ?? latest
      end = match.index + match[0].length
    }
    rest = rest.slice(Math.max(end, rest.length - TAIL))
    if (latest && latest !== sent && now() - at >= GAP_MS) {
      sent = latest
      at = now()
      send(latest)
    }
  }
}
