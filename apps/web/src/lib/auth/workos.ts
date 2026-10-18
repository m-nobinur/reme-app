import { WorkOS } from "@workos-inc/node"

/**
 * The WorkOS client and the four values it needs.
 *
 * Everything here is server-only. It is reached from server function handlers
 * and server route handlers, both of which the TanStack Start plugin strips out
 * of the client build; `pnpm --filter web size` asserts that the key is absent
 * from every client asset, which is the property ADR-026 replaced "lives in one
 * worker" with.
 *
 * Values come from `process.env`, which workerd populates from the Worker's
 * vars and secrets under `nodejs_compat`. Measured on this worker: a route
 * reading `navigator.userAgent` as `Cloudflare-Workers` read all four.
 */
function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is not set on this Worker. Local values go in apps/web/.dev.vars; deployed values are wrangler secrets.`
    )
  }
  return value
}

/**
 * How long WorkOS has to start answering, the same bound `apiFetch` gives
 * `apps/api`. The SDK's own default is 60 s, and it retried a timeout three
 * times with backoff, so a stalled WorkOS held a sign-in form for over four
 * minutes. An abort surfaces as a 408, which `toFailure` answers as `timeout`.
 */
export const WORKOS_TIMEOUT_MS = 10_000

/**
 * The timeout is given twice because the SDK's two builds read it from two
 * places: the Node build from `timeout`, the Worker build (the one workerd
 * resolves) from `config`, where its `createHttpClient` drops `timeout`.
 * Measured in 10.11.0 by `workos.test.ts`, which drives both builds.
 *
 * No retries: a retry doubles the wait, and a 429 or 503 retry sleeps for
 * whatever `Retry-After` says, up to 60 s. The person on the form is the retry.
 */
export const CLIENT_OPTIONS = {
  timeout: WORKOS_TIMEOUT_MS,
  config: { timeout: WORKOS_TIMEOUT_MS } as RequestInit,
  maxRetries: 0,
}

let client: WorkOS | undefined

export function workos(): WorkOS {
  client ??= new WorkOS(required("WORKOS_API_KEY"), {
    clientId: required("WORKOS_CLIENT_ID"),
    ...CLIENT_OPTIONS,
  })
  return client
}

export function cookiePassword(): string {
  return required("WORKOS_COOKIE_PASSWORD")
}

export function redirectUri(): string {
  return required("WORKOS_REDIRECT_URI")
}

/**
 * The browser's session cookie. `__Host-` forbids a `Domain`, so an owner's
 * site on a sibling `remeai.co.uk` host cannot plant one for this host. A
 * browser drops a `__Host-` cookie without `Secure`, and the kit sets
 * `Secure` from the redirect URI's scheme, so local http keeps the plain name.
 */
export function sessionCookie(): string {
  return process.env.WORKOS_REDIRECT_URI?.startsWith("https:")
    ? "__Host-wos-session"
    : "wos-session"
}

/**
 * Passed to every `authenticateWith*` call. The backend SDK seals the session
 * itself and hands back `sealedSession`, which is the whole of ADR-024: we
 * reproduce no cookie format and own no cryptography.
 */
export function sessionOptions() {
  return {
    session: { sealSession: true as const, cookiePassword: cookiePassword() },
  }
}
