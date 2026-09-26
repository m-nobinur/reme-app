import { createFileRoute } from "@tanstack/react-router"
import { getAuth } from "@workos/authkit-tanstack-react-start"
import { source } from "@/lib/api/source"
import { ownerFrom } from "@/lib/tenant"

/**
 * The chat's same-origin door to `apps/api`'s `/chat`, which runs the turn
 * and streams it back. The body goes through as the owner sent it and the
 * api validates it; only the session cookie travels with it, and the answer,
 * a UI message stream or a refusal, comes back untouched.
 */
export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // The backend of an authed page, so it answers like one: a 401 the
        // chat client can read, rather than the layout's redirect, which a
        // `fetch` would see as an opaque parse failure. It also keeps an
        // anonymous POST from costing a round trip to the api.
        if (!ownerFrom(await getAuth())) {
          return Response.json(
            { error: "This request carries no session we can read." },
            { status: 401 }
          )
        }
        const body: unknown = await request.json().catch(() => null)
        const answer = await source.chat(body)
        return (
          answer ??
          Response.json(
            { error: "This request carries no session we can read." },
            { status: 401 }
          )
        )
      },
    },
  },
})
