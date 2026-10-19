import { readReplyToken } from "@workspace/contracts"
import {
  eq,
  logFailure,
  memberships,
  type Posted,
  postOwnerEmail,
  sql,
  type Tenancy,
  users,
} from "@workspace/db"
import PostalMime, { type Header } from "postal-mime"

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
 * writes for the checks it ran on receipt, and only as the topmost header.
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
 * `Authentication-Results` is read, and it must be the trusted server's: the
 * receiving server prepends its header, so one written by the sender sits
 * below it, and if the topmost is not ours, ours was never written. Likewise
 * for `ARC-Authentication-Results`, where the topmost must also carry the
 * highest instance. A header is never skipped for a lower one; the ARC copy is
 * read only when there is no `Authentication-Results` at all. No such header,
 * an unreadable one or an explicit DMARC failure is a no, so a change in what
 * Cloudflare writes fails closed.
 */
export function authenticated(headers: Header[], fromDomain: string): boolean {
  const from = fromDomain.toLowerCase()
  const instance = (value: string) =>
    Number(/^\s*i=(\d+)/.exec(value)?.[1] ?? 0)
  for (const name of ["authentication-results", "arc-authentication-results"]) {
    const all = headers.filter((h) => h.key === name)
    const [top] = all
    if (!top) continue
    if (
      name.startsWith("arc") &&
      instance(top.value) < Math.max(...all.map((h) => instance(h.value)))
    ) {
      return false
    }
    const mine = results(top.value)
    if (mine.server !== TRUSTED_AUTH_SERVER) return false
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

type Refusal = { reason: string; say?: string }

/** What a refused mail is told when the sender is not yet known to be the owner: nothing a probe could use. */
const NOT_ACCEPTED = "Message not accepted."
/** What the owner is told once the sender has checked out as the owner. */
const OPEN_REME = "Reme could not take this reply. Open Reme to continue."

type InboundEnv = {
  HYPERDRIVE: Hyperdrive
  REPLY_TOKEN_KEY: string
  /** Where replies are addressed: `reply.remeai.co.uk`, or the apex when the rule sits there. */
  REPLY_DOMAIN: string
}

/** The token in `reply+<token>@<REPLY_DOMAIN>`, or null for any other address. */
function tokenOf(to: string, domain: string): string | null {
  const at = to.lastIndexOf("@")
  const local = to.slice(0, at)
  if (at < 0 || to.slice(at + 1).toLowerCase() !== domain.toLowerCase()) {
    return null
  }
  return local.startsWith("reply+") ? local.slice("reply+".length) : null
}

/**
 * The Email Worker (ADR-043). A refusal is `setReject`, a permanent error in
 * the SMTP session itself, so nothing here sends a bounce to a sender that
 * may be forged. Cheap checks run first, and none reads the body before the
 * token and the size are right. Starts no model turn: the row it writes is
 * logged to the CoS by the owner's next typed turn.
 */
export async function receive(
  message: ForwardableEmailMessage,
  env: InboundEnv,
  kit: Tenancy
): Promise<void> {
  const seen: { org_id?: string } = {}
  const done = (outcome: "accepted" | "refused", reason: string) =>
    console.log(
      JSON.stringify({ code: "inbound_email", outcome, reason, ...seen })
    )
  const refuse = ({ reason, say = NOT_ACCEPTED }: Refusal) => {
    message.setReject(say)
    done("refused", reason)
  }
  try {
    const token = tokenOf(message.to, env.REPLY_DOMAIN)
    if (!token) return refuse({ reason: "address" })
    const named = await readReplyToken(env.REPLY_TOKEN_KEY, token)
    if (!named) return refuse({ reason: "token" })
    if (message.rawSize > MAX_RAW_BYTES) return refuse({ reason: "size" })
    const raw = await new Response(message.raw).arrayBuffer()
    if (raw.byteLength > MAX_RAW_BYTES) return refuse({ reason: "size" })
    const mail = await PostalMime.parse(raw)
    const sender = mail.from?.address?.toLowerCase()
    if (!sender?.includes("@")) return refuse({ reason: "sender" })
    if (!authenticated(mail.headers, sender.split("@").pop() as string)) {
      return refuse({ reason: "authentication" })
    }
    seen.org_id = named.orgId
    if (!(await isOwner(kit, named.orgId, sender))) {
      return refuse({ reason: "not_owner" })
    }
    // From here the sender is the owner, so a refusal may say why.
    const text = stripReply(mail.text ?? "")
    if (!text) return refuse({ reason: "empty", say: OPEN_REME })
    if (text.length > MAX_TEXT) {
      return refuse({
        reason: "text_length",
        say: "That reply is too long for Reme. Open Reme to write it there.",
      })
    }
    const posted = await postOwnerEmail(kit, {
      orgId: named.orgId,
      conversationId: named.conversationId,
      // The Message-ID makes a redelivery `exists`; without one the words do.
      key: mail.messageId ?? `${named.conversationId}:${text}`,
      text,
    })
    const say: Record<Exclude<Posted, "posted" | "exists">, string> = {
      none: OPEN_REME,
      busy: "Reme is busy with this conversation. Send your reply again in a minute.",
      waiting:
        "Reme is waiting for your answer in the app. Open Reme to reply.",
    }
    if (posted === "posted" || posted === "exists")
      return done("accepted", posted)
    refuse({ reason: posted, say: say[posted] })
  } catch (error) {
    logFailure({ where: "inbound_email" }, error)
    refuse({ reason: "error", say: OPEN_REME })
  }
}

/** Whether `email` is the address of an active owner of the org. */
async function isOwner(
  kit: Tenancy,
  orgId: string,
  email: string
): Promise<boolean> {
  const rows = await kit.withOrg({ orgId }, (db) =>
    db
      .select({ email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        sql`${memberships.role} = 'owner' and ${memberships.status} = 'active'`
      )
  )
  return rows.some((row) => row.email.toLowerCase() === email)
}
