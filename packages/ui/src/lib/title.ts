/** The most a conversation title holds, in UTF-16 units as the contract counts. */
const TITLE_MAX = 120

/**
 * A title as the owner typed it, the way the api keeps it: one line, trimmed,
 * single spaces, at most 120 units, cut before a character rather than
 * inside one. Null when nothing is left, which the api would refuse.
 */
export function titleText(input: string): string | null {
  let title = ""
  for (const character of input.replace(/\s+/g, " ").trim()) {
    if (title.length + character.length > TITLE_MAX) break
    title += character
  }
  return title.trimEnd() || null
}
