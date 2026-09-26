import { createFileRoute } from "@tanstack/react-router"
import { getAuth } from "@workos/authkit-tanstack-react-start"
import { source } from "@/lib/api/source"
import { readCapped } from "@/lib/body"
import { ownerFrom } from "@/lib/tenant"

/**
 * The chat's same-origin door to `apps/api`'s `/chat`, which runs the turn
 * and streams it back. The body goes through as the owner sent it, unparsed,
 * and the api validates it; only the session cookie travels with it, and the
 * answer, a UI message stream or a refusal, comes back untouched.
 */

/** `apps/api`'s own cap on a `/chat` body. */
const BODY_CAP = 64 * 1024

/**
 * 401 rather than the layout's redirect: this is a `fetch` from the chat
 * client, and a 307 to /sign-in would arrive as an opaque parse failure
 * instead of an answer the caller can act on.
 */
const unauthenticated = () =>
  Response.json(
    { error: "This request carries no session we can read." },
    { status: 401 }
  )

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // The backend of an authed page, so it answers like one, before it
        // reads a byte of the body or costs a round trip to the api.
        if (!ownerFrom(await getAuth())) return unauthenticated()
        const body = await readCapped(request, BODY_CAP)
        if (body === null) {
          return Response.json(
            { error: "This message is too long to send." },
            { status: 413 }
          )
        }
        return (await source.chat(body)) ?? unauthenticated()
      },
    },
  },
})
