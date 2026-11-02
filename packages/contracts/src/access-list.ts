/**
 * Who may sign in while the app is invite-only.
 *
 * The list is a comma-separated string, `ALLOWED_EMAILS` on the web and api
 * Workers. An entry is `name@domain`, which allows that one address, or
 * `*@domain`, which allows every address at exactly that domain.
 *
 * Gmail ignores dots and anything after a plus in the part before the `@`, so
 * for gmail.com and googlemail.com the entry `a.b@gmail.com` also allows
 * `ab+test@gmail.com`. Other domains match the address exactly: a plus there
 * can be a different mailbox.
 *
 * Unset or blank means no list, so everyone is allowed (local development,
 * tests, production). A list whose entries all fail to parse allows no one.
 */
export type AccessList = {
  domains: ReadonlySet<string>
  addresses: ReadonlySet<string>
}

const GMAIL = new Set(["gmail.com", "googlemail.com"])
const UNSAFE = /[\s"'<>(),;:\\]/

function split(value: string): { local: string; domain: string } | null {
  const lowered = value.trim().toLowerCase()
  const at = lowered.lastIndexOf("@")
  if (at < 1 || at === lowered.length - 1) return null
  const local = lowered.slice(0, at)
  const domain = lowered.slice(at + 1)
  if (local.includes("@") || UNSAFE.test(lowered)) return null
  return { local, domain }
}

function canonical(value: string): { local: string; domain: string } | null {
  const parts = split(value)
  if (!parts) return null
  if (!GMAIL.has(parts.domain)) return parts
  const local = (parts.local.split("+")[0] ?? "").replaceAll(".", "")
  return local ? { local, domain: "gmail.com" } : null
}

export function parseAccessList(raw: string | undefined): AccessList | null {
  if (!raw?.trim()) return null
  const domains = new Set<string>()
  const addresses = new Set<string>()
  for (const entry of raw.split(/[,\s]+/)) {
    if (entry.startsWith("*@")) {
      const domain = canonical(`x@${entry.slice(2)}`)?.domain
      if (domain) domains.add(domain)
      continue
    }
    const parts = canonical(entry)
    if (parts) addresses.add(`${parts.local}@${parts.domain}`)
  }
  return { domains, addresses }
}

export function emailAllowed(email: string, list: AccessList | null): boolean {
  if (!list) return true
  const parts = canonical(email)
  if (!parts) return false
  return (
    list.domains.has(parts.domain) ||
    list.addresses.has(`${parts.local}@${parts.domain}`)
  )
}
