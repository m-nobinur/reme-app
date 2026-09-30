import { createFileRoute } from "@tanstack/react-router"
import { consumeOAuthState, seeOther } from "@/lib/auth/oauth"
import { authenticate } from "@/lib/auth/session"
import { sessionOptions, workos } from "@/lib/auth/workos"

/**
 * Where the provider sends the browser back.
 *
 * This is the route the WorkOS environment's redirect URI names, so its path is
 * fixed by configuration rather than by taste. It handles the callback itself
 * rather than delegating to the kit's `handleCallbackRoute`, because the flow it
 * is completing is the one `/api/auth/social` started: the kit's callback looks
 * for the PKCE verifier cookie its own `getAuthorizationUrl` would have written
 * and fails with `PKCECookieMissingError` when it is not there.
 *
 * Owning it also means one code path turns an authentication response into a
 * session, so MFA and organisation selection behave the same whether the person
 * arrived by password or by Google.
 */
function back(origin: string, path: string): Response {
  return seeOther(new URL(path, origin).href)
}

export const Route = createFileRoute("/api/auth/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const { origin } = url

        // The provider's own refusal, which arrives instead of a code when
        // someone presses cancel on the consent screen.
        const providerError = url.searchParams.get("error")
        if (providerError) {
          return back(origin, "/sign-in?error=cancelled")
        }

        const code = url.searchParams.get("code")
        const flow = consumeOAuthState(url.searchParams.get("state"))
        if (!(code && flow)) {
          // Either a callback with no code, or one whose state does not match a
          // flow this browser started. Both are refused the same way, and the
          // state cookie has already been spent either way.
          return back(origin, "/sign-in?error=callback")
        }

        const outcome = await authenticate(
          () =>
            workos().userManagement.authenticateWithCode({
              code,
              ...sessionOptions(),
            }),
          { email: "", returnTo: flow.returnTo, nameBusiness: true }
        )

        if (outcome.status === "failed") {
          return back(origin, "/sign-in?error=callback")
        }
        return back(origin, outcome.redirectTo)
      },
    },
  },
})
