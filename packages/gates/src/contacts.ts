/**
 * The contacts a message carries, for the check that a message the owner
 * did not ask for points them only where a trusted fact does: the owner's
 * updates and a proactive CoS turn. Text injected into a review or a page can
 * shape such a message, never point the owner somewhere.
 */

/** Web and email addresses and bare hosts. */
const ADDRESS = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+|(?:[\w-]+\.)+[a-z]{2,}\b/gi
/** A web address, ending where a reader would end it. */
const LINK = /https?:\/\/[^\s"”)<>,;\]]+/gi
/** Seven digits or more, each pair apart by up to three spaces, dots, slashes, brackets or dashes. */
const PHONE = /\+?\d(?:[\s./()\-‐-―]{0,3}\d){6,}/gu
/** Characters that change nothing a reader sees. */
const HIDDEN = /[\p{Cf}\p{Mn}\p{Default_Ignorable_Code_Point}]/gu
/** Ways to write a dot that a reader still reads as one. */
const DOTS = /[․。﹒．｡]|[[({]\s*(?:\.|dot)\s*[\])}]|\s+dot\s+/giu

/**
 * The contacts in `text`, each in one form, after folding what could hide
 * one: compatibility characters, invisible characters and dot look-alikes.
 * A web address counts as its host, and the rest of it is read as text, so
 * a host or an address in its path or user part counts too. A phone number
 * counts as its digits; a host keeps its dashes, so `bright-clean` is not
 * `brightclean`.
 */
export function contactsIn(text: string): string[] {
  const hosts: string[] = []
  const plain = text
    .normalize("NFKC")
    .replace(HIDDEN, "")
    .replace(DOTS, ".")
    .replace(LINK, (found) => {
      try {
        const url = new URL(found)
        hosts.push(url.hostname)
        const rest = `${url.username} ${url.password} ${url.pathname}${url.search}${url.hash}`
        let readable = rest
        try {
          readable = decodeURIComponent(rest)
        } catch {
          // A malformed escape is read as it stands.
        }
        return ` ${readable.replace(/[/?#&=]/g, " ")} `
      } catch {
        return ` ${found.replace(/^https?:\/\//i, "")} `
      }
    })
  const addresses = (plain.match(ADDRESS) ?? []).map((found) =>
    found.toLowerCase()
  )
  const phones = (plain.match(PHONE) ?? []).map((found) =>
    found.replace(/\D/g, "")
  )
  return [...hosts, ...addresses, ...phones]
}

/** Whether every contact in `text` is one `trusted` holds exactly. */
export const vouched = (text: string, trusted: readonly string[]) => {
  const allowed = new Set(trusted.flatMap(contactsIn))
  return contactsIn(text).every((found) => allowed.has(found))
}
