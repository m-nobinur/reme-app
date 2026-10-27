import { DomainError } from "./domains.ts"

/**
 * RDAP, the registries' public answer to "is this name registered, and who
 * sold it": 200 registered, 404 free (checked 2026-10-27 at Nominet for
 * `.uk` and Verisign for `.com`). The registry for a name comes from IANA's
 * bootstrap file. Registries rate-limit, and a name's registrar rarely moves,
 * so an answer is kept in the colo's cache for a day.
 */

const BOOTSTRAP = "https://data.iana.org/rdap/dns.json"
export const RDAP_TIMEOUT_MS = 5_000
const DAY = 24 * 60 * 60

export type Registration = { registered: boolean; registrar?: string }

/**
 * A GET through the Workers cache. Only a 200 is kept: a free name that is
 * bought an hour later must not read free until tomorrow.
 */
async function cachedGet(url: string): Promise<Response> {
  const key = new Request(url)
  const hit = await caches.default.match(key)
  if (hit) return hit
  const response = await fetch(url, {
    headers: { accept: "application/rdap+json, application/json" },
    signal: AbortSignal.timeout(RDAP_TIMEOUT_MS),
  })
  if (response.status === 200) {
    await caches.default.put(
      key,
      new Response(await response.clone().text(), {
        headers: { "cache-control": `public, max-age=${DAY}` },
      })
    )
  }
  return response
}

/** The RDAP base URL of the registry that runs `name`'s ending, or null if IANA lists none. */
async function registryOf(name: string): Promise<string | null> {
  const response = await cachedGet(BOOTSTRAP)
  if (response.status !== 200) {
    await response.body?.cancel()
    throw new DomainError("rdap.unavailable")
  }
  const { services } = (await response.json()) as {
    services: Array<[string[], string[]]>
  }
  const ending = name.slice(name.lastIndexOf(".") + 1)
  const urls = services.find(([endings]) => endings.includes(ending))?.[1]
  const base = urls?.find((u) => u.startsWith("https://")) ?? urls?.[0]
  return base ? (base.endsWith("/") ? base : `${base}/`) : null
}

/** "123-Reg Limited t/a 123-reg" is "123-reg", "NameCheap, Inc." is "NameCheap". */
function tidy(registrar: string): string {
  const trading = registrar.split(/\s+t\/a\s+/i).at(-1) ?? registrar
  return trading.replace(/,?\s+(limited|ltd\.?|inc\.?|llc|llp|gmbh|plc)$/i, "")
}

/** The `fn` of the entity with the registrar role, in the vCard RDAP carries. */
function registrarOf(body: {
  entities?: Array<{ roles?: string[]; vcardArray?: [string, unknown[][]] }>
}): string | undefined {
  const entity = body.entities?.find((e) => e.roles?.includes("registrar"))
  const fn = entity?.vcardArray?.[1]?.find((p) => p[0] === "fn")?.[3]
  return typeof fn === "string" && fn.trim()
    ? tidy(fn.trim()).slice(0, 80)
    : undefined
}

/**
 * Whether `name` is registered and with whom. Null when IANA lists no RDAP
 * server for its ending, so the caller falls back on DNS. Throws
 * `rdap.unavailable` for a server that is down or rate-limiting.
 *
 * shortcut: asks about the name as given, so a subdomain reads as free; the
 * callers pass an owner's domain, not a host under it. Reduce to the
 * registrable name with the public suffix list if that ever bites.
 */
export async function rdapLookup(name: string): Promise<Registration | null> {
  const base = await registryOf(name)
  if (!base) return null
  const response = await cachedGet(`${base}domain/${encodeURIComponent(name)}`)
  if (response.status === 404) {
    await response.body?.cancel()
    return { registered: false }
  }
  if (response.status !== 200) {
    await response.body?.cancel()
    throw new DomainError("rdap.unavailable")
  }
  const registrar = registrarOf(await response.json())
  return { registered: true, ...(registrar && { registrar }) }
}
