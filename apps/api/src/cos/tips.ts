import { ownDomain, type TipKind } from "@workspace/contracts"

/**
 * UK area codes (after +44, no trunk 0) and the places each serves, for the
 * big cities only. shortcut: an unlisted code or area says nothing, so no
 * tip; add a row when a real owner's number should have been caught.
 */
const AREAS: Record<string, readonly string[]> = {
  "20": ["london"],
  "23": ["southampton", "portsmouth"],
  "24": ["coventry"],
  "29": ["cardiff"],
  "113": ["leeds"],
  "114": ["sheffield"],
  "115": ["nottingham"],
  "116": ["leicester"],
  "117": ["bristol"],
  "118": ["reading"],
  "121": ["birmingham"],
  "131": ["edinburgh"],
  "141": ["glasgow"],
  "151": ["liverpool"],
  "161": ["manchester"],
  "191": ["newcastle", "gateshead", "sunderland", "durham"],
}

const CITIES = Object.values(AREAS).flat()

const text = (value: unknown, key: string) => {
  const found = (value as Record<string, unknown> | undefined)?.[key]
  return typeof found === "string" ? found.toLowerCase() : ""
}

/** The places a geographic number belongs to, or null for a mobile, a non-geographic or an unlisted one. */
const placesOf = (e164: string) => {
  const national = e164.startsWith("+44") ? e164.slice(3) : ""
  const code = [3, 2].map((n) => national.slice(0, n)).find((c) => c in AREAS)
  return code ? (AREAS[code] ?? null) : null
}

/** Whether the number is from a listed city other than the ones the business's area names. */
function farFromHome(e164: string, area: string): boolean {
  const places = placesOf(e164)
  const named = CITIES.filter((city) => area.includes(city))
  return !!places && named.length > 0 && !places.some((p) => named.includes(p))
}

export type TipFacts = {
  facts: readonly { key: string; value: unknown }[]
  /** The website has been published. */
  live: boolean
  /** The states of the org's domains that are not removed. */
  domains: readonly string[]
  given: readonly TipKind[]
}

/**
 * The tips worth offering now, each at most once ever. A business email waits
 * for a domain of the owner's own, since that is what it would run on.
 */
export function tipsDue({ facts, live, domains, given }: TipFacts): TipKind[] {
  if (!live) return []
  const value = (key: string) => facts.find((f) => f.key === key)?.value
  const email = text(value("business.email"), "address")
  const phone = text(value("business.phone"), "e164")
  const area = `${text(value("service_area.radius"), "centre")} ${text(value("service_area.text"), "text")}`
  const owns = domains.some((state) =>
    ["awaiting_dns", "verifying", "active"].includes(state)
  )
  const due: TipKind[] = []
  if (email && !ownDomain(email) && owns) due.push("business_email")
  if (phone && farFromHome(phone, area)) due.push("local_phone")
  return due.filter((kind) => !given.includes(kind))
}
