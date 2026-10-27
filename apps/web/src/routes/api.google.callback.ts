import { createFileRoute } from "@tanstack/react-router"
import type { GoogleResultRequest } from "@workspace/contracts"
import { source } from "@/lib/api/source"
import { consumeOAuthState, seeOther } from "@/lib/auth/oauth"
import { safeReturnTo } from "@/lib/auth/redirect-target"
import { googleFlow } from "@/lib/google"

/**
 * Where Google sends the browser back. The state cookie is spent on every exit,
 * and neither the code nor the verifier is logged. The code goes to `apps/api`,
 * which re-checks the session and the owner role before anything is connected.
 * How it ended is said in the chat, by the assistant, and the owner lands back
 * in the conversation the cookie remembers.
 */
export const Route = createFileRoute("/api/google/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url)
        const flow = googleFlow(url.origin)
        const state = url.searchParams.get("state")
        const stored = consumeOAuthState(state, flow)
        // The cookie is ours, but a sibling host on the zone could toss one.
        const back = () =>
          seeOther(new URL(safeReturnTo(stored?.returnTo), url.origin).href)
        // Once per attempt. Only a state that matched our cookie names its
        // attempt; any other request (an expired cookie, a forged link) shares
        // one key an hour, so a link someone else made cannot fill the chat.
        const tell = async (result: GoogleResultRequest["result"]) => {
          const attempt =
            stored && state
              ? state
              : `unverified-${new Date().toISOString().slice(0, 13)}`
          await source.googleResult(attempt, result)
          return back()
        }
        if (url.searchParams.get("error") === "access_denied") {
          // The owner's choice. Said only for a flow this browser started.
          return stored ? tell("cancelled") : back()
        }
        const code = url.searchParams.get("code")
        if (!(code && stored?.verifier)) return tell("failed")

        return tell(
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
