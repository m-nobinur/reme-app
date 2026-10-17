import { createFileRoute } from "@tanstack/react-router"
import { getAuth } from "@workos/authkit-tanstack-react-start"
import { beginOAuth, pkcePair, seeOther } from "@/lib/auth/oauth"
import { googleFlow, SCOPES } from "@/lib/google"
import { ownerFrom } from "@/lib/tenant"

/**
 * Sends the owner to Google's consent screen to connect Search Console. The
 * code that comes back is exchanged by `apps/orchestrator`, the only place the
 * client secret lives, so this side holds the public client id and a PKCE
 * verifier in the state cookie. Who may connect is `apps/api`'s call (an owner
 * role there); the session's role claim is not that role, so it is not read here.
 */
export const Route = createFileRoute("/api/google/start")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { origin } = new URL(request.url)
        const owner = ownerFrom(await getAuth())
        if (!owner?.orgId) return seeOther(new URL("/sign-in", origin).href)
        const clientId = process.env.GOOGLE_CLIENT_ID
        if (!clientId) {
          return seeOther(new URL("/app?google=unavailable", origin).href)
        }

        const { verifier, challenge } = await pkcePair()
        const { state, redirectUri } = beginOAuth("/app", googleFlow(origin), {
          verifier,
        })
        const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth")
        auth.search = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: SCOPES,
          access_type: "offline",
          prompt: "consent",
          include_granted_scopes: "true",
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
        }).toString()
        return seeOther(auth.href)
      },
    },
  },
})
