/**
 * The token in an owner email's `Reply-To: reply+<token>@…` (ADR-043). It
 * names one org and one conversation and proves we issued the pair: the two
 * ids in binary, then an HMAC-SHA256 over them truncated to 80 bits (the
 * floor RFC 2104 allows), 56 URL-safe characters, so `reply+` and the token
 * fit the 64 characters a local part may have. Both Workers hold the key as
 * `REPLY_TOKEN_KEY`. WebCrypto only, because the orchestrator, the api and
 * their tests all run it.
 *
 * The ids are readable by anyone who holds an email, which is no secret to
 * that person; a guess is only as good as the MAC, and the receiver checks
 * the sender separately.
 */

const ID_BYTES = 16
const MAC_BYTES = 10
const PURPOSE = new TextEncoder().encode("reme.reply-token.v1")

const idBytes = (id: string) => {
  const hex = id.replaceAll("-", "")
  return Uint8Array.from({ length: ID_BYTES }, (_, i) =>
    Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  )
}

const idText = (bytes: Uint8Array) => {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

async function mac(key: string, ids: Uint8Array): Promise<Uint8Array> {
  const hmac = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const input = new Uint8Array(PURPOSE.length + ids.length)
  input.set(PURPOSE)
  input.set(ids, PURPOSE.length)
  const full = new Uint8Array(await crypto.subtle.sign("HMAC", hmac, input))
  return full.slice(0, MAC_BYTES)
}

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")

export async function replyToken(
  key: string,
  orgId: string,
  conversationId: string
): Promise<string> {
  if (!UUID.test(orgId) || !UUID.test(conversationId)) {
    throw new Error("A reply token names two lower-case UUIDs.")
  }
  const ids = new Uint8Array(2 * ID_BYTES)
  ids.set(idBytes(orgId))
  ids.set(idBytes(conversationId), ID_BYTES)
  return toBase64Url(Uint8Array.from([...ids, ...(await mac(key, ids))]))
}

/**
 * `mailbox` is the environment's base address, `reply@reply.remeai.co.uk` in
 * production. Each environment needs its own, because one routing rule sends
 * an address to one Worker. Its local part is at most 7 characters, so it,
 * the `+` and the 56-character token fit a 64-character local part.
 */
export function replyAddress(mailbox: string, token: string): string {
  const at = mailbox.indexOf("@")
  if (at < 1 || at > 7)
    throw new Error(
      "A reply mailbox is a local part of 1 to 7 characters and a domain."
    )
  return `${mailbox.slice(0, at)}+${token}${mailbox.slice(at)}`
}

/** The token in `<local>+<token>@<domain>` for this mailbox, or null for any other address. */
export function tokenFromAddress(mailbox: string, to: string): string | null {
  const at = mailbox.indexOf("@")
  const prefix = `${mailbox.slice(0, at)}+`.toLowerCase()
  const domain = mailbox.slice(at + 1).toLowerCase()
  const split = to.lastIndexOf("@")
  if (split < 0 || to.slice(split + 1).toLowerCase() !== domain) return null
  const local = to.slice(0, split)
  return local.toLowerCase().startsWith(prefix)
    ? local.slice(prefix.length)
    : null
}

/** The pair a token names, or null when it is not one we issued under `key`. */
export async function readReplyToken(
  key: string,
  token: string
): Promise<{ orgId: string; conversationId: string } | null> {
  if (!key || !/^[A-Za-z0-9_-]{56}$/.test(token)) return null
  const bytes = Uint8Array.from(
    atob(token.replaceAll("-", "+").replaceAll("_", "/")),
    (c) => c.charCodeAt(0)
  )
  const ids = bytes.slice(0, 2 * ID_BYTES)
  const given = bytes.slice(2 * ID_BYTES)
  const expected = await mac(key, ids)
  // Compared without stopping at the first difference.
  let diff = 0
  for (let i = 0; i < MAC_BYTES; i++)
    diff |= (given[i] ?? 0) ^ (expected[i] ?? 0)
  if (diff !== 0) return null
  return {
    orgId: idText(ids.slice(0, ID_BYTES)),
    conversationId: idText(ids.slice(ID_BYTES)),
  }
}
