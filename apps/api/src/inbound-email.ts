import type { Header } from "postal-mime"

/**
 * An owner's emailed reply (ADR-043). Everything in the message is attacker
 * input until the checks here have passed, so each one is a small function
 * that answers yes or no and the handler stops at the first no.
 */

/** Raw bytes before parsing. Cloudflare allows 25 MiB; a reply is text, and attachments are never read. */
export const MAX_RAW_BYTES = 1_048_576

/** What a typed message may hold (`GOAL_MAX` in the contracts). */
export const MAX_TEXT = 4000

/**
 * The only authserv-id whose results are believed: the one Email Routing
 * writes for the checks it ran on receipt. A header any other host wrote, or
 * the sender put there, names another id and is skipped.
 */
export const TRUSTED_AUTH_SERVER = "mx.cloudflare.net"

type Result = { method: string; value: string; props: Map<string, string> }

/** One `Authentication-Results` value (RFC 8601): the id, then `method=value prop=value` entries. */
function results(value: string): { server: string; results: Result[] } {
  const [first = "", ...rest] = value
    .replace(/\([^)]*\)/g, " ")
    .split(";")
    .map((part) => part.trim())
  // An ARC copy leads with its instance tag, `i=1`, then the id.
  const [head = "", ...entries] = /^i=\d+$/.test(first)
    ? rest
    : [first, ...rest]
  return {
    server: head.toLowerCase(),
    results: entries.flatMap((entry) => {
      const lead = /^([a-z0-9-]+)=([a-z]+)\s*(.*)$/i.exec(entry)
      if (!lead) return []
      const props = new Map<string, string>()
      for (const [, name, quoted, bare] of (lead[3] ?? "").matchAll(
        /([a-z0-9-]+\.[a-z0-9-]+)=(?:"([^"]*)"|(\S+))/gi
      )) {
        props.set(
          (name ?? "").toLowerCase(),
          (quoted ?? bare ?? "").toLowerCase()
        )
      }
      return [
        {
          method: (lead[1] ?? "").toLowerCase(),
          value: (lead[2] ?? "").toLowerCase(),
          props,
        },
      ]
    }),
  }
}

/** Relaxed alignment: the checked domain is the From domain or a parent of it. */
const aligned = (checked: string | undefined, from: string) =>
  !!checked?.includes(".") && (from === checked || from.endsWith(`.${checked}`))

/**
 * Whether Email Routing's own results show the From domain authenticated: DMARC
 * passed, or SPF or DKIM passed for a domain aligned with it. Only the topmost
 * header the trusted server wrote is read, since a result a sender planted
 * sits below the one added on receipt. No such header, an unreadable one or an
 * explicit DMARC failure is a no, so a change in what Cloudflare writes fails
 * closed.
 */
export function authenticated(headers: Header[], fromDomain: string): boolean {
  const from = fromDomain.toLowerCase()
  for (const name of ["authentication-results", "arc-authentication-results"]) {
    const mine = headers
      .filter((h) => h.key === name)
      .map((h) => results(h.value))
      .find((r) => r.server === TRUSTED_AUTH_SERVER)
    if (!mine) continue
    const pass = (method: string, prop: string) =>
      mine.results.some(
        (r) =>
          r.method === method &&
          r.value === "pass" &&
          (method === "dmarc"
            ? r.props.get(prop) === from
            : aligned(r.props.get(prop)?.split("@").pop(), from))
      )
    if (mine.results.some((r) => r.method === "dmarc" && r.value === "fail")) {
      return false
    }
    return (
      pass("dmarc", "header.from") ||
      pass("dkim", "header.d") ||
      pass("spf", "smtp.mailfrom")
    )
  }
  return false
}

/** Where a client starts quoting the message it replies to, in the languages owners write in. */
const WROTE = "wrote|schrieb|a écrit|escribió|ha scritto|schreef|escreveu"
const ATTRIBUTION = new RegExp(
  `^(?:On|Am|Le|El|Il|Op|Em)\\b[\\s\\S]{1,300}?\\b(?:${WROTE})\\b[\\s\\S]{0,120}?:\\s*$`,
  "im"
)
const ORIGINAL =
  /^[-_ ]{2,}\s*(?:Original Message|Ursprüngliche Nachricht|Message d'origine|Mensaje original|Messaggio originale)\s*[-_ ]{2,}$/im
// Outlook's block: a From line, then Sent or Date within the next lines.
const HEADER_BLOCK =
  /^(?:From|Von|De|Da):\s.+\n(?:.*\n)?(?:Sent|Date|Gesendet|Envoyé|Enviado|Inviato):\s/im
const SIGNATURE = /^-- ?$/m
const DEVICE_LINE = /(?:^|\n)(?:Sent from my .+|Get Outlook for .+)$/i

/**
 * The words the owner wrote: text from the first sign of quoted history or a
 * signature delimiter is cut, `>` lines inside what is left are dropped, and
 * a trailing "Sent from my phone" line goes. When nothing is left the reply
 * was only quotation, and the caller refuses it.
 */
export function stripReply(text: string): string {
  let kept = text.replaceAll("\r\n", "\n")
  for (const marker of [ATTRIBUTION, ORIGINAL, HEADER_BLOCK, SIGNATURE]) {
    const at = kept.search(marker)
    if (at >= 0) kept = kept.slice(0, at)
  }
  return kept
    .split("\n")
    .filter((line) => !line.startsWith(">"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(DEVICE_LINE, "")
    .trim()
}
