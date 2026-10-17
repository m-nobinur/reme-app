import { createFileRoute } from "@tanstack/react-router"
import { source } from "@/lib/api/source"
import { consumeOAuthState, seeOther } from "@/lib/auth/oauth"
import { googleFlow } from "@/lib/google"

/**
 * Where Google sends the browser back. The state cookie is spent on every exit,
 * and neither the code nor the verifier is logged. The code goes to `apps/api`,
 * which re-checks the session and the owner role before anything is connected.
 */
export const Route = createFileRoute("/api/google/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const flow = googleFlow(url.origin)
        const back = (result: string) =>
          seeOther(new URL(`/app?google=${result}`, url.origin).href)

        const stored = consumeOAuthState(url.searchParams.get("state"), flow)
        if (url.searchParams.get("error") === "access_denied") {
          return back("cancelled")
        }
        const code = url.searchParams.get("code")
        if (!(code && stored?.verifier)) return back("failed")

        return back(
          await source.googleConnect({
            code,
            verifier: stored.verifier,
            redirect_uri: flow.redirectUri,
          })
        )
      },
    },
  },
})
