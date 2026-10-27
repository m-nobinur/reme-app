/**
 * Custom domains, connect path: the Cloudflare for SaaS custom hostname
 * client, the DoH inspector, provider detection for the DNS-settings button,
 * and the `DomainCheck` that decides when a domain may go live. Everything
 * here reads public DNS or our own SaaS zone; nothing writes the owner's DNS.
 */
import type {
  DnsRecord,
  DomainCheck,
  DomainProvider,
} from "@workspace/contracts"

/** Where every connected host points: a proxied record in our SaaS zone (D0). */
export const CNAME_TARGET = "domains.remeai.co.uk"
/** Our own zone: never a Domain Connect settings host. */
export const OUR_ZONE = "remeai.co.uk"

/** A failure the caller logs by code (`failureCode` reads `name`). */
export class DomainError extends Error {
  constructor(code: string) {
    super(code)
    this.name = code
  }
}

// ---------------------------------------------------------------------------
// Cloudflare for SaaS custom hostnames
// ---------------------------------------------------------------------------

/** Both come from env: the token is a secret, the zone is per environment. */
export type CloudflareEnv = {
  CF_DOMAINS_TOKEN?: string
  CF_DOMAINS_ZONE_ID?: string
}

/** The fields of a custom hostname this code reads, as the API returns them. */
export type CustomHostname = {
  id: string
  hostname: string
  status: string
  ssl?: {
    status?: string
    validation_records?: Array<{ txt_name?: string; txt_value?: string }>
    validation_errors?: Array<{ message?: string }>
  }
  ownership_verification?: { name?: string; type?: string; value?: string }
  verification_errors?: string[]
}

export const CF_API = "https://api.cloudflare.com/client/v4"
export const CF_TIMEOUT_MS = 10_000

async function customHostnames(
  env: CloudflareEnv,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<Response> {
  if (!env.CF_DOMAINS_TOKEN || !env.CF_DOMAINS_ZONE_ID) {
    throw new DomainError("domains.not_configured")
  }
  return fetch(
    `${CF_API}/zones/${env.CF_DOMAINS_ZONE_ID}/custom_hostnames${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${env.CF_DOMAINS_TOKEN}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(CF_TIMEOUT_MS),
    }
  )
}

/** The `result` of a v4 envelope, or the first error's code as the failure. */
export async function resultOf<T>(response: Response): Promise<T> {
  const json = (await response.json().catch(() => ({}))) as {
    success?: boolean
    errors?: Array<{ code?: number }>
    result?: T
  }
  if (!response.ok || json.success !== true || json.result === undefined) {
    throw new DomainError(
      `cloudflare.${json.errors?.[0]?.code ?? response.status}`
    )
  }
  return json.result
}

/**
 * The custom hostname for `hostname` that this claim holds, created if
 * Cloudflare has none, so a retried Workflow step never makes a second. HTTP
 * DCV: the certificate validates once the owner's CNAME reaches us.
 *
 * One that exists already is adopted only when the row holds its id. Any
 * other belongs to an earlier claim or to the other environment sharing the
 * zone, and is refused as `domain.hostname_held`, never reused, so this
 * environment never deletes a hostname it did not create. Cloudflare's
 * `custom_metadata`, which could name the owner, is Enterprise only.
 *
 * shortcut: a step that dies after its create answered but before the id is
 * stored leaves that hostname unowned, and the claim fails as held. Delete it
 * by hand from the zone's Custom Hostnames page if that ever happens.
 */
export async function ensureHostname(
  env: CloudflareEnv,
  hostname: string,
  claim: { id?: string }
): Promise<CustomHostname> {
  const found = await resultOf<CustomHostname[]>(
    await customHostnames(
      env,
      "GET",
      `?hostname.exact=${encodeURIComponent(hostname)}`
    )
  )
  const existing = found.find((h) => h.hostname === hostname)
  if (existing) {
    if (existing.id === claim.id) return existing
    throw new DomainError("domain.hostname_held")
  }
  return resultOf<CustomHostname>(
    await customHostnames(env, "POST", "", {
      hostname,
      ssl: { method: "http", type: "dv" },
    })
  )
}

/** The hostname's current state, or null when Cloudflare no longer has it. */
export async function getHostname(
  env: CloudflareEnv,
  id: string
): Promise<CustomHostname | null> {
  const response = await customHostnames(
    env,
    "GET",
    `/${encodeURIComponent(id)}`
  )
  if (response.status === 404) {
    await response.body?.cancel()
    return null
  }
  return resultOf<CustomHostname>(response)
}

/** Deletes the hostname and its certificate; one already gone is done. */
export async function deleteHostname(
  env: CloudflareEnv,
  id: string
): Promise<void> {
  const response = await customHostnames(
    env,
    "DELETE",
    `/${encodeURIComponent(id)}`
  )
  await response.body?.cancel()
  if (!response.ok && response.status !== 404) {
    throw new DomainError(`cloudflare.${response.status}`)
  }
}

// ---------------------------------------------------------------------------
// DoH inspector
// ---------------------------------------------------------------------------

const DOH = "https://cloudflare-dns.com/dns-query"
export const DOH_TIMEOUT_MS = 2_000
const TYPES = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  CAA: 257,
} as const
type RecordType = keyof typeof TYPES
type Answer = { name: string; type: number; data: string }

const bare = (name: string) => name.toLowerCase().replace(/\.$/, "")

async function doh(
  name: string,
  type: RecordType
): Promise<{ status: number; answers: Answer[]; authority: Answer[] }> {
  const response = await fetch(
    `${DOH}?name=${encodeURIComponent(name)}&type=${type}`,
    {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
    }
  )
  if (!response.ok) {
    await response.body?.cancel()
    throw new DomainError("dns.unavailable")
  }
  const body = (await response.json()) as {
    Status: number
    Answer?: Answer[]
    Authority?: Answer[]
  }
  // NOERROR and NXDOMAIN are answers; SERVFAIL and the rest are a failed lookup.
  if (body.Status !== 0 && body.Status !== 3) {
    throw new DomainError("dns.unavailable")
  }
  return {
    status: body.Status,
    answers: body.Answer ?? [],
    authority: body.Authority ?? [],
  }
}

/** What sits at one host itself, not at the end of its CNAME chain. */
export type HostRecords = { cname?: string; a: string[]; aaaa: string[] }

export type Inspection = {
  /** The zone apex, from the SOA. */
  apex: string
  nameservers: string[]
  onCloudflare: boolean
  /**
   * The subdomain the owner named, which is served on its own name with no
   * `www`; absent for a zone apex or its `www`.
   */
  sub?: string
  /** Keyed by fully qualified name: the apex and `www.{apex}`, or `sub` alone. */
  hosts: Record<string, HostRecords>
  /** The addresses `CNAME_TARGET` resolves to, to recognise a flattened ALIAS. */
  target: string[]
  /** CAA at the apex, presentation format: `0 issue "pki.goog"`. */
  caa: string[]
}

async function hostRecords(host: string): Promise<HostRecords> {
  // An A or AAAA query returns the host's own CNAME first in its chain, so a
  // separate CNAME query would add nothing.
  const [a, aaaa] = await Promise.all([doh(host, "A"), doh(host, "AAAA")])
  const own = (answers: Answer[], type: number) =>
    answers.filter((x) => x.type === type && bare(x.name) === host)
  const cname = own([...a.answers, ...aaaa.answers], TYPES.CNAME)[0]
  return {
    ...(cname ? { cname: bare(cname.data) } : {}),
    a: own(a.answers, TYPES.A).map((x) => x.data),
    aaaa: own(aaaa.answers, TYPES.AAAA).map((x) => x.data),
  }
}

/**
 * The zone apex above `name`, from its SOA, and whether `name` itself is
 * NXDOMAIN, as a subdomain is before its record is added. Throws
 * `domain.not_found` when no zone answers at all.
 */
export async function zoneApex(
  name: string
): Promise<{ apex: string; missing: boolean }> {
  const host = bare(name)
  const soa = await doh(host, "SOA")
  // A name holding a CNAME is never a zone apex, and its SOA answer follows
  // the CNAME to the target's zone: ask its parent instead.
  if (
    soa.answers.some((x) => x.type === TYPES.CNAME && bare(x.name) === host)
  ) {
    const parent = host.slice(host.indexOf(".") + 1)
    if (!parent.includes(".")) throw new DomainError("domain.not_found")
    return { apex: (await zoneApex(parent)).apex, missing: false }
  }
  const zone = [...soa.answers, ...soa.authority].find(
    (x) => x.type === TYPES.SOA
  )
  if (!zone) throw new DomainError("domain.not_found")
  return { apex: bare(zone.name), missing: soa.status === 3 }
}

/**
 * Public DNS for a domain the owner named, apex, `www` or another subdomain:
 * the zone apex from the SOA, then NS, the records at the hosts to serve
 * (the apex and `www`, or the subdomain alone) and CAA. Throws
 * `domain.not_found` for a name that does not exist.
 */
export async function inspect(name: string): Promise<Inspection> {
  const { apex, missing } = await zoneApex(name)
  const asked = bare(name).replace(/^www\./, "")
  const sub = asked !== apex ? asked : undefined
  const www = `www.${apex}`
  const served = sub ? [sub] : [apex, www]
  const [ns, records, a, aaaa, caa] = await Promise.all([
    doh(apex, "NS"),
    Promise.all(served.map(async (h) => [h, await hostRecords(h)] as const)),
    doh(CNAME_TARGET, "A"),
    doh(CNAME_TARGET, "AAAA"),
    doh(apex, "CAA"),
  ])
  // A name with no records of its own is a subdomain still to be added, and
  // only under a zone in use: one with an address, a CNAME or mail. A registry
  // zone such as co.uk has none, so an unregistered name is still refused.
  // shortcut: a heuristic, not the public suffix list; add the list if a
  // registry zone with an apex address ever lets a name through.
  if (missing) {
    if (!sub) throw new DomainError("domain.not_found")
    const [root, mx] = await Promise.all([hostRecords(apex), doh(apex, "MX")])
    const inUse =
      !!root.cname ||
      root.a.length + root.aaaa.length > 0 ||
      mx.answers.some((x) => x.type === TYPES.MX)
    if (!inUse) throw new DomainError("domain.not_found")
  }
  const data = (answers: Answer[], type: number) =>
    answers.filter((x) => x.type === type).map((x) => x.data)
  const nameservers = data(ns.answers, TYPES.NS).map(bare)
  return {
    apex,
    nameservers,
    onCloudflare: nameservers.some((n) => n.endsWith(".cloudflare.com")),
    ...(sub && { sub }),
    hosts: Object.fromEntries(records),
    target: [...data(a.answers, TYPES.A), ...data(aaaa.answers, TYPES.AAAA)],
    caa: data(caa.answers, TYPES.CAA),
  }
}

// ---------------------------------------------------------------------------
// Provider detection and the DNS-settings button
// ---------------------------------------------------------------------------

export const SETTINGS_TIMEOUT_MS = 2_000
export const SETTINGS_MAX_BYTES = 10 * 1024

/**
 * The only DNS-settings links a card ever shows, keyed by the host a
 * provider's settings answer names. The answer only picks an entry; the link
 * is always ours, because the TXT and the settings JSON both come from the
 * domain's own DNS and cannot vouch for themselves.
 */
export const SETTINGS_LINKS: Readonly<Record<string, string>> = {
  "dcc.godaddy.com": "https://dcc.godaddy.com/manage/dns",
  "dcc.secureserver.net": "https://dcc.secureserver.net/manage/dns",
  "dash.cloudflare.com": "https://dash.cloudflare.com/",
}

const IONOS: DomainProvider = {
  name: "IONOS",
  settings_url: "https://my.ionos.co.uk/domains",
}

/**
 * Without a Domain Connect record: the nameserver suffix names the provider.
 * Each link was fetched on 2026-10-27 and answered 200 or a redirect to the
 * provider's sign-in; the owner lands on their account's domain list or DNS
 * page after signing in. GoDaddy and Cloudflare answer a script 403 behind
 * bot checks and were checked by their redirects to sign-in alone.
 */
const NAMESERVERS: ReadonlyArray<[string, DomainProvider]> = [
  [
    ".cloudflare.com",
    { name: "Cloudflare", settings_url: "https://dash.cloudflare.com/" },
  ],
  [
    ".domaincontrol.com",
    { name: "GoDaddy", settings_url: "https://dcc.godaddy.com/manage/dns" },
  ],
  [
    ".123-reg.co.uk",
    { name: "123-reg", settings_url: "https://www.123-reg.co.uk/secure/" },
  ],
  [".ui-dns.com", IONOS],
  [".ui-dns.org", IONOS],
  [".ui-dns.biz", IONOS],
  [".ui-dns.de", IONOS],
  [
    ".registrar-servers.com",
    {
      name: "Namecheap",
      settings_url: "https://ap.www.namecheap.com/domains/list/",
    },
  ],
  [
    ".googledomains.com",
    {
      name: "Squarespace",
      settings_url: "https://account.squarespace.com/domains",
    },
  ],
  [
    ".wixdns.net",
    { name: "Wix", settings_url: "https://manage.wix.com/account/domains" },
  ],
  [
    ".livedns.co.uk",
    { name: "Fasthosts", settings_url: "https://admin.fasthosts.co.uk/" },
  ],
  [
    ".gandi.net",
    { name: "Gandi", settings_url: "https://admin.gandi.net/domain" },
  ],
  [
    ".ns.porkbun.com",
    {
      name: "Porkbun",
      settings_url: "https://porkbun.com/account/domainsSpeedy",
    },
  ],
]

/**
 * A `_domainconnect` TXT value as `host[/path]`, or null. Refuses a scheme
 * other than https, ports, user info, IP literals (including the numeric
 * forms a URL parser reads as IPv4) and anything under our own zone.
 */
export function settingsBase(value: string): string | null {
  const base = value
    .trim()
    .toLowerCase()
    .replace(/^https:\/\//, "")
    .replace(/\/+$/, "")
  const [host = "", ...path] = base.split("/")
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null
  if (/(^|\.)(\d+|0x[0-9a-f]*)$/.test(host)) return null
  if (host === OUR_ZONE || host.endsWith(`.${OUR_ZONE}`)) return null
  if (path.some((p) => !/^[a-z0-9._-]+$/.test(p) || p === "." || p === ".."))
    return null
  return base
}

/** A body read only up to `max` bytes; a longer one is refused, not cut. */
async function readCapped(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ""
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      throw new DomainError("provider.too_large")
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

const txt = (data: string) => data.replace(/"\s*"/g, "").replace(/^"|"$/g, "")

function linkFor(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:"
      ? SETTINGS_LINKS[parsed.hostname]
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Domain Connect discovery: the provider's own name, and our link if we have
 * one. The settings host is any public host the domain's TXT names, as the
 * spec intends, so an unknown provider still gets its name. What bounds that:
 * a Worker's subrequests leave through Cloudflare's public egress and reach
 * no private network, the GET carries no credential, the answer is cut to an
 * 80-character name, and a link is only ever one of `SETTINGS_LINKS`.
 */
async function discover(apex: string): Promise<DomainProvider | null> {
  const { answers } = await doh(`_domainconnect.${apex}`, "TXT")
  const base = answers
    .filter((x) => x.type === TYPES.TXT)
    .map((x) => settingsBase(txt(x.data)))
    .find((b) => b !== null)
  if (!base) return null
  const response = await fetch(
    `https://${base}/v2/${encodeURIComponent(apex)}/settings`,
    {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(SETTINGS_TIMEOUT_MS),
    }
  )
  if (response.status !== 200) {
    await response.body?.cancel()
    return null
  }
  const settings = JSON.parse(
    await readCapped(response, SETTINGS_MAX_BYTES)
  ) as Record<string, unknown>
  const shown = settings.providerDisplayName ?? settings.providerName
  // Shown in the card: printable characters only, at the contract's length.
  const name =
    typeof shown === "string"
      ? shown
          .replace(/[\p{Cc}\p{Cf}]/gu, "")
          .trim()
          .slice(0, 80)
      : ""
  if (!name) return null
  const settingsUrl =
    linkFor(settings.urlControlPanel) ?? linkFor(settings.urlSyncUX)
  return settingsUrl ? { name, settings_url: settingsUrl } : { name }
}

/**
 * Who runs the domain's DNS: Domain Connect discovery first, which tells
 * GoDaddy's brands apart, then the nameserver table, then nobody. A provider
 * discovery names without a page of ours gets the table's page for the same
 * nameservers. Never throws: a card without a provider still works.
 */
export async function detectProvider(
  apex: string,
  nameservers: string[]
): Promise<DomainProvider | null> {
  const discovered = await discover(apex).catch(() => null)
  const row = NAMESERVERS.find(([suffix]) =>
    nameservers.some((n) => bare(n).endsWith(suffix))
  )
  if (discovered) {
    const link = row?.[1].settings_url
    return discovered.settings_url || !link
      ? discovered
      : { ...discovered, settings_url: link }
  }
  return row ? { ...row[1] } : null
}

// ---------------------------------------------------------------------------
// Records and the check
// ---------------------------------------------------------------------------

/** The CAs Cloudflare issues custom hostname certificates from. */
export const OUR_CAS = ["pki.goog", "letsencrypt.org", "ssl.com"]
/** Cloudflare's own CAA line for Google Trust Services, its first choice. */
export const CAA_FOR_US = '0 issue "pki.goog; cansignhttpexchanges=yes"'

/**
 * The apex's `issue` CAA lines when they allow none of our CAs; empty when
 * there are none or one allows us.
 *
 * shortcut: reads the apex only. A CAA set on `www` itself would override it
 * for that host; add a `www` lookup if a real domain ever has one.
 */
export function blockingCaa(caa: string[]): string[] {
  const issue = caa.filter((line) => /^\d+\s+issue\s/i.test(line))
  const allowed = issue.some((line) => {
    const value = line.replace(/^\d+\s+issue\s+/i, "").replace(/"/g, "")
    const [ca = ""] = value.split(";")
    return OUR_CAS.includes(ca.trim().toLowerCase())
  })
  return allowed ? [] : issue
}

/** `name` relative to the apex, as a provider's DNS page asks for it. */
export function relative(name: string, apex: string): string {
  const host = bare(name)
  if (host === apex) return "@"
  return host.endsWith(`.${apex}`) ? host.slice(0, -apex.length - 1) : host
}

/** How the bare domain reaches the site: an ALIAS to us, or the provider's forward to `www`. */
export type ApexMode = "alias" | "forward"

/**
 * The records the owner adds. `www`, or the subdomain, CNAMEs to us. The apex gets an
 * ALIAS in alias mode; in forward mode it is the provider's redirect to
 * `https://www.{apex}`, which no record expresses. A CAA line is added when
 * the domain's CAA would refuse our CAs. A guarded claim's ownership TXT is
 * the caller's, from the row.
 */
export function recordsFor(input: {
  inspection: Inspection
  apex: ApexMode
}): DnsRecord[] {
  const { apex, sub } = input.inspection
  const records: DnsRecord[] = [
    {
      type: "CNAME",
      name: sub ? relative(sub, apex) : "www",
      value: CNAME_TARGET,
    },
  ]
  if (!sub && input.apex === "alias") {
    records.push({ type: "ALIAS", name: "@", value: CNAME_TARGET })
  }
  if (blockingCaa(input.inspection.caa).length > 0) {
    records.push({ type: "CAA", name: "@", value: CAA_FOR_US })
  }
  return records
}

/**
 * The records still to add: those of `recordsFor` that public DNS does not
 * already show reaching us, so a card never asks for what is there. A CAA line
 * is only ever in the list because the domain's own blocks us. Strict on the
 * owner's Cloudflare, as `alreadyPointsAtUs` is, where only a visible CNAME counts.
 */
export function stillToAdd(
  records: DnsRecord[],
  inspection: Inspection
): DnsRecord[] {
  const strict = { ...inspection, onCloudflare: false }
  return records.filter((record) => {
    if (record.type === "CAA") return true
    const host =
      record.name === "@"
        ? inspection.apex
        : `${record.name}.${inspection.apex}`
    const seen = inspection.hosts[host]
    return !(seen && pointsAtUs(seen, strict))
  })
}

/**
 * Whether a host's records reach us: its CNAME is our target, or its
 * addresses are all our target's (a flattened ALIAS).
 *
 * shortcut: on the owner's Cloudflare a proxied record shows Cloudflare's
 * addresses, never the CNAME behind it, so any address counts and the
 * hostname's own status is the signal there. Compare against Cloudflare's
 * published ranges if that ever lets a stale record through.
 */
function pointsAtUs(records: HostRecords, inspection: Inspection): boolean {
  if (records.cname) return records.cname === CNAME_TARGET
  const addresses = [...records.a, ...records.aaaa]
  if (addresses.length === 0) return false
  if (inspection.onCloudflare) return true
  return addresses.every((a) => inspection.target.includes(a))
}

/**
 * Whether the apex or `www` already reaches us before a claim exists: a
 * record left from an earlier claim, which would let a new one go live on DNS
 * alone. Strict on the owner's Cloudflare, where only a visible CNAME counts.
 */
export function alreadyPointsAtUs(inspection: Inspection): boolean {
  const strict = { ...inspection, onCloudflare: false }
  return Object.values(inspection.hosts).some((records) =>
    pointsAtUs(records, strict)
  )
}

/** Whether public DNS shows the TXT record `name` with `value`. */
export async function hasTxt(name: string, value: string): Promise<boolean> {
  const { answers } = await doh(name, "TXT")
  return answers.some((x) => x.type === TYPES.TXT && txt(x.data) === value)
}

/**
 * Whether the bare domain is served directly (an ALIAS or a flattened CNAME
 * to us) or forwards to `www`. Its own custom hostname being active settles
 * it; otherwise its addresses must be ours, which the owner's own Cloudflare
 * cannot show (see `pointsAtUs`), so there only the hostname counts.
 */
export function apexMode(
  inspection: Inspection,
  apexHostname: CustomHostname | null
): ApexMode {
  if (apexHostname?.status === "active") return "alias"
  const records = inspection.hosts[inspection.apex]
  return records && !inspection.onCloudflare && pointsAtUs(records, inspection)
    ? "alias"
    : "forward"
}

/** Records at a host that should reach us and do not: an old A, AAAA or CNAME. */
function conflictsAt(host: string, inspection: Inspection): DnsRecord[] {
  const records = inspection.hosts[host]
  if (!records || pointsAtUs(records, inspection)) return []
  const name = relative(host, inspection.apex)
  if (records.cname) return [{ type: "CNAME", name, value: records.cname }]
  if (inspection.onCloudflare) return []
  const elsewhere = (a: string) => !inspection.target.includes(a)
  return [
    ...records.a
      .filter(elsewhere)
      .map((value) => ({ type: "A" as const, name, value })),
    ...records.aaaa
      .filter(elsewhere)
      .map((value) => ({ type: "AAAA" as const, name, value })),
  ]
}

/**
 * One check, in dub's verify order: the edge does not know the host, a
 * record is in the way, the hostname is not verified, the records point
 * elsewhere, the certificate is not issued, and only then valid. `hosts` are
 * the fully qualified names that must reach us: `www`, plus the apex in alias
 * mode, each with its custom hostname or null. `unknown_error` is the
 * caller's, when the inspection or the hostname read itself failed.
 */
export function domainCheck(
  inspection: Inspection,
  hosts: Array<{ host: string; hostname: CustomHostname | null }>
): DomainCheck {
  const known = hosts.flatMap(({ host, hostname }) =>
    hostname ? [{ host, hostname }] : []
  )
  if (known.length === 0 || known.length < hosts.length) {
    return { status: "not_found" }
  }
  const conflicts = [
    ...known.flatMap((h) => conflictsAt(h.host, inspection)),
    ...blockingCaa(inspection.caa).map((value) => ({
      type: "CAA" as const,
      name: "@",
      value,
    })),
  ].slice(0, 10)
  if (conflicts.length > 0) return { status: "conflicting_record", conflicts }
  if (known.some((h) => h.hostname.status !== "active")) {
    return { status: "pending_verification" }
  }
  const missing = known.some((h) => {
    const records = inspection.hosts[h.host]
    return !records || !pointsAtUs(records, inspection)
  })
  if (missing) return { status: "invalid_configuration" }
  if (known.some((h) => h.hostname.ssl?.status !== "active")) {
    return { status: "pending_certificate" }
  }
  return { status: "valid" }
}
