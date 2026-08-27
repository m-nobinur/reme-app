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

let client: WorkOS | undefined

export function workos(): WorkOS {
  client ??= new WorkOS(required("WORKOS_API_KEY"), {
    clientId: required("WORKOS_CLIENT_ID"),
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
 * Passed to every `authenticateWith*` call. The backend SDK seals the session
 * itself and hands back `sealedSession`, which is the whole of ADR-024: we
 * reproduce no cookie format and own no cryptography.
 */
export function sessionOptions() {
  return {
    session: { sealSession: true as const, cookiePassword: cookiePassword() },
  }
}
