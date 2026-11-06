/**
 * A business's WhatsApp token at rest: AES-GCM under `CHANNEL_TOKEN_KEY` (32
 * bytes, base64), stored as `v1.<iv>.<ct>` in base64url, the format
 * `whatsapp_accounts_token_sealed` checks. The org id is the AAD, so a
 * ciphertext copied to another org's row does not open.
 */
type KeyEnv = Pick<Env, "CHANNEL_TOKEN_KEY">

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
const unb64 = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0)
  )
const utf8 = (text: string) => new TextEncoder().encode(text)

async function tokenKey(env: KeyEnv): Promise<CryptoKey> {
  let bytes: Uint8Array | undefined
  try {
    bytes = env.CHANNEL_TOKEN_KEY ? unb64(env.CHANNEL_TOKEN_KEY) : undefined
  } catch {
    // Not base64: refused as the wrong length below.
  }
  if (bytes?.length !== 32) throw new Error("channel.bad_key")
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ])
}

export async function sealToken(
  env: KeyEnv,
  orgId: string,
  token: string
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: utf8(orgId) },
    await tokenKey(env),
    utf8(token)
  )
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(sealed))}`
}

export async function openToken(
  env: KeyEnv,
  orgId: string,
  stored: string
): Promise<string> {
  const key = await tokenKey(env)
  const [version, iv, sealed, extra] = stored.split(".")
  if (version !== "v1" || !iv || !sealed || extra !== undefined) {
    throw new Error("channel.bad_token")
  }
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(iv), additionalData: utf8(orgId) },
      key,
      unb64(sealed)
    )
    return new TextDecoder().decode(plain)
  } catch {
    throw new Error("channel.bad_token")
  }
}

/** What `channel_link_codes.hash` holds for a one-time code: SHA-256, base64url. */
export async function hashCode(code: string): Promise<string> {
  return b64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(code)))
  )
}
