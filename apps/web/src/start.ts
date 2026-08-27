import { createCsrfMiddleware, createStart } from "@tanstack/react-start"
import { authkitMiddleware } from "@workos/authkit-tanstack-react-start"

/**
 * Server functions are same-origin RPC endpoints, and every form in the sign-in
 * flow is one. Without this, another origin can POST a password change or a
 * sign-in attempt at this Worker and the browser will attach the cookies.
 * TanStack Start ships the check but does not register it, and warns at dev time
 * that it is missing — which is how this got here.
 *
 * Scoped to server functions. Route handlers under /api/auth are reached by a
 * top-level GET navigation from a provider, which no CSRF token survives; those
 * carry their own `state` cookie check instead.
 */
const csrfMiddleware = createCsrfMiddleware({
  filter: (context) => context.handlerType === "serverFn",
})

/**
 * The AuthKit middleware reads and refreshes the sealed owner session on every
 * request and puts the result in TanStack's server context, where `getAuth()`
 * and our own server functions read it. It also opens the pending-header channel
 * that `saveSession` writes Set-Cookie through, so a custom page cannot
 * establish a session without it (ADR-026).
 */
export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware, authkitMiddleware()],
}))
