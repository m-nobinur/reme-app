import {
  createCsrfMiddleware,
  createMiddleware,
  createStart,
} from "@tanstack/react-start"
import {
  type AuthKitContext,
  authkitMiddleware,
  getAuthkit,
} from "@workos/authkit-tanstack-react-start"
import { whyNoUser } from "@/lib/auth/diagnose"
import { cspMiddleware } from "@/lib/csp"

/**
 * Server functions are same-origin RPC endpoints, and every form in the sign-in
 * flow is one. Without this, another origin can POST a password change or a
 * sign-in attempt at this Worker and the browser will attach the cookies.
 * TanStack Start ships the check but does not register it, and warns at dev time
 * that it is missing — which is how this got here.
 *
 * Server functions, and any route handler a request would change state
 * through, such as the chat and upload POSTs under /api. A GET or HEAD to a
 * route skips it: the OAuth callbacks are reached by a top-level GET
 * navigation from a provider, which no CSRF token survives, and carry their
 * own `state` cookie check instead.
 */
export const csrfMiddleware = createCsrfMiddleware({
  filter: (context) =>
    context.handlerType === "serverFn" ||
    !["GET", "HEAD"].includes(context.request.method),
})

/**
 * One log line when a request brought a session cookie and AuthKit still
 * found no user, saying why (`lib/auth/diagnose.ts`). Runs after AuthKit's
 * middleware and only on that path, so a signed-in request pays nothing.
 */
const noUserLog = createMiddleware().server(
  async ({ request, next, context }) => {
    // What `authkitMiddleware` put in the context for the requests after it.
    const auth = (
      context as unknown as Partial<AuthKitContext> | undefined
    )?.auth?.()
    if (
      auth &&
      !auth.user &&
      /(?:^|;\s*)wos-session=/.test(request.headers.get("cookie") ?? "")
    ) {
      console.warn(JSON.stringify(await whyNoUser(request, await getAuthkit())))
    }
    return next()
  }
)

/**
 * The AuthKit middleware reads and refreshes the sealed owner session on every
 * request and puts the result in TanStack's server context, where `getAuth()`
 * and our own server functions read it. It also opens the pending-header channel
 * that `saveSession` writes Set-Cookie through, so a custom page cannot
 * establish a session without it (ADR-026).
 *
 * The CSP middleware goes first, so its nonce is in the context `getRouter`
 * reads and every HTML answer gets the header, whatever runs after it.
 */
export const startInstance = createStart(() => ({
  requestMiddleware: [
    cspMiddleware,
    csrfMiddleware,
    authkitMiddleware(),
    noUserLog,
  ],
}))
