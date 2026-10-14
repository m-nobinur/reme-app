/**
 * A section heading may set one clause in the accent by wrapping it in
 * asterisks: "Why agents keep *rebooking us*". No marker, no accent, and an
 * unpaired asterisk is plain text. Only section headings read it: a page's h1,
 * title and description are shown as written.
 */
export function accentParts(text: string): {
  lead: string
  accent: string
  tail: string
} {
  const found = /^(.*?)\*([^*]+)\*(.*)$/s.exec(text)
  return found
    ? { lead: found[1] ?? "", accent: found[2] ?? "", tail: found[3] ?? "" }
    : { lead: text, accent: "", tail: "" }
}

/** The heading as plain text, for an h1 or a title that shares a section heading's field. */
export const plain = (text: string): string =>
  text.replace(/\*([^*]+)\*/g, "$1")
