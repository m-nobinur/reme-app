import { createFileRoute } from "@tanstack/react-router"
import { source } from "@/lib/api/source"
import { consumeOAuthState, seeOther } from "@/lib/auth/oauth"
import { safeReturnTo } from "@/lib/auth/redirect-target"
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
        const stored = consumeOAuthState(url.searchParams.get("state"), flow)
        const back = (shown: string) => {
          // The cookie is ours, but a sibling host on the zone could toss one.
          const to = new URL(safeReturnTo(stored?.returnTo), url.origin)
          to.searchParams.set("google", shown)
          return seeOther(to.href)
        }
        // Besides the banner, the chat says it, once per attempt.
        const failed = async (why: "failed" | "scopes_missing") => {
          const attempt = url.searchParams.get("state") ?? crypto.randomUUID()
          await source.googleFailed(attempt, why)
          return back(why)
        }
        if (url.searchParams.get("error") === "access_denied") {
          return back("cancelled")
        }
        const code = url.searchParams.get("code")
        if (!(code && stored?.verifier)) return failed("failed")

        const result = await source.googleConnect({
          code,
          verifier: stored.verifier,
          redirect_uri: flow.redirectUri,
        })
        return result === "connected" ? back(result) : failed(result)
      },
    },
  },
})
