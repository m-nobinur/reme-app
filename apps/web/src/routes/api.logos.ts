import { createFileRoute } from "@tanstack/react-router"
import { getAuth } from "@workos/authkit-tanstack-react-start"
import { source } from "@/lib/api/source"
import { readCapped } from "@/lib/body"
import { ownerFrom } from "@/lib/tenant"

/**
 * The logo page's same-origin door to `apps/api`'s `/logos`: POST starts a
 * round, GET reads one question's rounds. A body goes through unparsed for
 * the api to validate; only the session cookie and the press's idempotency
 * key travel with it, and the answer comes back untouched.
 */

/** A brief and the owner's changes, with room to spare. */
const BODY_CAP = 16 * 1024

const refuse = (status: number, error: string) =>
  Response.json({ error }, { status })

const NO_SESSION = "This request carries no session we can read."

export const Route = createFileRoute("/api/logos")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!ownerFrom(await getAuth())) return refuse(401, NO_SESSION)
        const call = new URL(request.url).searchParams.get("tool_call_id")
        if (!call) return refuse(400, "Name the question the logos are for.")
        return (await source.logoRounds(call)) ?? refuse(401, NO_SESSION)
      },
      POST: async ({ request }) => {
        if (!ownerFrom(await getAuth())) return refuse(401, NO_SESSION)
        const body = await readCapped(request, BODY_CAP)
        if (body === null) {
          return refuse(413, "This description is too long. Shorten it.")
        }
        const key =
          request.headers.get("idempotency-key") ?? crypto.randomUUID()
        return (await source.drawLogos(body, key)) ?? refuse(401, NO_SESSION)
      },
    },
  },
})
