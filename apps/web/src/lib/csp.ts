import { createMiddleware } from "@tanstack/react-start"

/**
 * The content security policy every HTML page is sent with.
 *
 * Scripts run only from this origin or with this request's nonce. TanStack
 * Start threads the nonce through everything it renders inline (the hydration
 * data, the route scripts, React's streaming scripts) once `getRouter` passes
 * it as `ssr.nonce`, and `__root.tsx` puts it on our two inline scripts.
 *
 * Styles keep 'unsafe-inline'. The UI primitives write `style` attributes into
 * server-rendered markup, which a nonce cannot cover, and a stylesheet cannot
 * run code.
 *
 * Images: the app, data URLs (the MFA QR code), blob URLs (the previews of
 * photos an owner picks before uploading them) and any host on remeai.co.uk,
 * which holds the signed preview hosts the screenshots come from but also
 * every tenant site and the api hosts, all ours. A backstop for the chat's
 * markdown, which drops images itself. Unsafe once a tenant site answers
 * `{slug}.remeai.co.uk/api/*` (Phase 3, reserved in apps/router/src/index.ts),
 * since an image request could then deliver what its URL carries to that
 * site's API. Screenshots must then come from one fixed host or through
 * 'self', and this narrows to match. Under `vite dev` only, the local
 * preview host (http, `*.reme.localhost`, any port) is allowed too, since a
 * local build is not served from remeai.co.uk. A built Worker never has it.
 *
 * `connect-src 'self'`: the browser calls only this Worker. `apps/api` and
 * WorkOS are reached from the server, bar the api's dictation socket. The
 * other exception is Stripe: a domain
 * purchase pays in embedded Checkout, which must load Stripe.js from
 * js.stripe.com and talk to Stripe itself. The hosts are Stripe's own list
 * for Stripe.js and Checkout (docs.stripe.com/security/guide, 2026-10-16);
 * hooks.stripe.com is the 3D Secure frame.
 */
const STRIPE_SCRIPTS =
  "https://js.stripe.com https://*.js.stripe.com https://checkout.stripe.com"

/**
 * The api's own WebSocket origin, for voice dictation: the microphone streams
 * to it directly, since the session cookie does not reach that host and a
 * ticket does. Nothing else of the api's is reachable from the browser.
 */
function dictationSocket(api: string | undefined): string {
  if (!api) return ""
  const { protocol, host } = new URL(api)
  return ` ${protocol === "https:" ? "wss:" : "ws:"}//${host}`
}

export function contentSecurityPolicy(
  nonce: string,
  dev = import.meta.env.DEV,
  api = process.env.REME_API_URL
): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' ${STRIPE_SCRIPTS}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: https://*.remeai.co.uk${dev ? " http://*.reme.localhost:*" : ""}`,
    "font-src 'self' data:",
    `connect-src 'self' https://api.stripe.com https://checkout.stripe.com${dictationSocket(api)}`,
    `frame-src ${STRIPE_SCRIPTS} https://hooks.stripe.com`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ")
}

/** 128 random bits, base64, fresh for every request. */
function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes))
}

/**
 * Makes the nonce, hands it to the router through the request context, and
 * sets the header on the HTML that comes back. Other answers (server function
 * JSON, redirects, the chat stream) run no scripts and are left alone.
 */
export const cspMiddleware = createMiddleware().server(async ({ next }) => {
  const nonce = newNonce()
  const result = await next({ context: { nonce } })
  if (result.response.headers.get("content-type")?.startsWith("text/html")) {
    result.response.headers.set(
      "Content-Security-Policy",
      contentSecurityPolicy(nonce)
    )
  }
  return result
})
