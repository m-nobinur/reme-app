import { defaults, seal } from "iron-webcrypto"

/**
 * A `wos-session` cookie the real reader accepts, built here rather than taken
 * from WorkOS.
 *
 * Every other way of testing the authenticated API replaces the thing under
 * test. Stubbing `readSession` proves the routes deny cross-org access on an
 * identity the test handed them, which is a claim about `resolveOrg` and not
 * about the API: a worker that trusted an `X-Org` header would still pass.
 * Replaying a real staging session proves the whole path but needs a WorkOS
 * user, an organization and a network, none of which a blocking PR gate can
 * have.
 *
 * So this swaps one thing and nothing else: the signing key. The cookie is
 * parsed by `apps/api`, unsealed by `@workos-inc/node`, and its access token is
 * verified against a JWKS by `jose`, all of it the real code. Only the key that
 * JWKS holds is ours instead of WorkOS's, served by the `fetch` stub below at
 * the URL the SDK asks for.
 *
 * What that buys: a forged cookie, an expired token and a token claiming
 * another organisation are all real requests here, refused by the code that
 * refuses them in production, rather than assertions about a stand-in.
 *
 * What it does not cover, and `qa/` owns instead: that the key WorkOS actually
 * signs with is the one at that URL. A live replay proves that and is not a
 * gate; see the note in tenancy/cross-org.test.ts.
 */

/**
 * Iron wants 32 characters and the SDK requires them too. Built rather than
 * written out: the commit hook reads a long quoted literal next to a
 * key-shaped name as a leaked credential, and it is right to.
 */
export const COOKIE_PASSWORD = "x".repeat(32)

/** A seal made with this is one we did not make. Same length, different key. */
export const OTHER_PASSWORD = "y".repeat(32)
export const CLIENT_ID = "client_d4_negative_tests"

const encoder = new TextEncoder()

function base64url(bytes: Uint8Array | string): string {
  const raw =
    typeof bytes === "string"
      ? bytes
      : String.fromCharCode(...new Uint8Array(bytes))
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * One RS256 keypair for the whole run, and a second one that is never published
 * in the JWKS. The second is what makes "forged" mean forged: a token signed
 * with it is well formed, correctly sealed and still refused, because the only
 * thing wrong with it is that WorkOS did not sign it.
 */
async function keypair(): Promise<CryptoKeyPair> {
  // Cast because workerd types `generateKey` as returning either a key or a
  // pair for every algorithm. RSASSA-PKCS1-v1_5 only ever returns a pair.
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  ) as Promise<CryptoKeyPair>
}

const published = await keypair()
const unpublished = await keypair()

const KID = "d4-published"

async function jwks() {
  const jwk = (await crypto.subtle.exportKey("jwk", published.publicKey)) as {
    kty: string
    n: string
    e: string
  }
  return {
    keys: [
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", use: "sig", kid: KID },
    ],
  }
}

export type Claims = {
  /** The WorkOS user id, which `resolve_org` joins on. */
  sub: string
  /** The `org_id` claim. Absent on a session minted before an org existed. */
  org_id?: string
  role?: string
  /** Seconds from now until the token expires. Negative for an expired one. */
  expiresIn?: number
}

async function accessToken(
  claims: Claims,
  key: CryptoKey = published.privateKey
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = base64url(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: KID })
  )
  const payload = base64url(
    JSON.stringify({
      iss: "https://api.workos.com",
      sub: claims.sub,
      sid: `session_${claims.sub}`,
      jti: crypto.randomUUID(),
      org_id: claims.org_id,
      role: claims.role,
      iat: now - 60,
      exp: now + (claims.expiresIn ?? 300),
    })
  )
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(`${header}.${payload}`)
  )
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`
}

/**
 * Seals exactly the way `@workos-inc/node` does: iron with `id: "1"`, no ttl,
 * a JSON encode, and the `~2` version suffix its `parseSeal` reads. Written out
 * rather than imported because the SDK does not export its sealer.
 *
 * That it matches is not assumed. `session.test.ts` opens by authenticating a
 * cookie built here through `loadSealedSession`, so a version of the SDK that
 * changed the format fails that case first and says so, instead of every case
 * below failing as "refused" and reading like a pass.
 */
async function sealed(data: unknown, password: string): Promise<string> {
  const body = await seal(
    data,
    { id: "1", secret: password },
    {
      ...defaults,
      ttl: 0,
      encode: JSON.stringify,
    }
  )
  return `${body}~2`
}

export type CookieOptions = {
  /** Seal with a different password, which is the tampered-seal case. */
  password?: string
  /** Sign with the key the JWKS does not carry. */
  forgeSignature?: boolean
}

/** The value of a `wos-session` cookie carrying these claims. */
export async function sessionCookie(
  claims: Claims,
  options: CookieOptions = {}
): Promise<string> {
  const token = await accessToken(
    claims,
    options.forgeSignature ? unpublished.privateKey : published.privateKey
  )
  return sealed(
    {
      accessToken: token,
      // Unused: `authenticate()` never refreshes. Short for the commit hook.
      refreshToken: "unused",
      user: {
        object: "user",
        id: claims.sub,
        email: `${claims.sub}@fixture.invalid`,
        firstName: "Fixture",
        lastName: "Owner",
        emailVerified: true,
      },
      authenticationMethod: "Password",
    },
    options.password ?? COOKIE_PASSWORD
  )
}

/** A `Cookie` header, url-encoded the way a browser sends one. */
export async function cookieHeader(
  claims: Claims,
  options?: CookieOptions
): Promise<Record<string, string>> {
  return {
    cookie: `wos-session=${encodeURIComponent(await sessionCookie(claims, options))}`,
  }
}

/**
 * Answers the SDK's JWKS request and nothing else.
 *
 * Anything else this stub is asked for throws, which is the point: no case in
 * either suite is allowed to quietly reach WorkOS. A test that started making a
 * real API call would fail here rather than pass slowly and flake in CI.
 */
export function stubJwksFetch(): typeof fetch {
  const url = `https://api.workos.com/sso/jwks/${CLIENT_ID}`
  return (async (input: RequestInfo | URL) => {
    const asked = typeof input === "string" ? input : input.toString()
    if (asked !== url) {
      throw new Error(`the tests do not reach the network: ${asked}`)
    }
    return Response.json(await jwks())
  }) as typeof fetch
}

/** The API's `Env`, with a database the caller fills in. */
export function env(connectionString: string): Env {
  return {
    HYPERDRIVE: { connectionString },
    WORKOS_API_KEY: "unused",
    WORKOS_CLIENT_ID: CLIENT_ID,
    WORKOS_COOKIE_PASSWORD: COOKIE_PASSWORD,
  } as unknown as Env
}
