/**
 * Domain Connect, synchronous flow: the signed link to the owner's DNS
 * provider's page that adds our record for them once they sign in there. The
 * template is infra/domain-connect/remeai.co.uk.website.json; Cloudflare
 * checks every link's signature against the public key at
 * `_dck1.remeai.co.uk`, which infra/domain-connect/keygen.ts prints.
 */

/** Our template: one CNAME at the applied host, so `www` for an apex. */
export const TEMPLATE = { provider: "remeai.co.uk", service: "website" }
/** The TXT label under `syncPubKeyDomain` holding the public key. */
export const KEY_HOST = "_dck1"

/**
 * RS256 over `query`, base64, as the spec's reference client signs it. `key`
 * is the private key as base64 of its PKCS #8 DER, one line for a secret.
 */
export async function sign(query: string, key: string): Promise<string> {
  const der = Uint8Array.from(atob(key), (c) => c.charCodeAt(0))
  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    der,
    algorithm,
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign(
    algorithm,
    privateKey,
    new TextEncoder().encode(query)
  )
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
}

/**
 * The apply link on `syncUX` (the provider's `urlSyncUX` as `host[/path]`).
 * The signature covers the query before `key` and `sig`, its parameters
 * sorted by name as the spec's canonical form has them, and `sig` comes
 * last, as Cloudflare requires.
 */
export async function applyUrl(
  syncUX: string,
  key: string,
  params: { domain: string; host: string; redirect_uri: string }
): Promise<string> {
  const query = new URLSearchParams(
    Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1))
  ).toString()
  const sig = encodeURIComponent(await sign(query, key))
  return `https://${syncUX}/v2/domainTemplates/providers/${TEMPLATE.provider}/services/${TEMPLATE.service}/apply?${query}&key=${KEY_HOST}&sig=${sig}`
}
