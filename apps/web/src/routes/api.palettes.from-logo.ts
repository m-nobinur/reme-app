import { createFileRoute } from "@tanstack/react-router"
import { getAuth } from "@workos/authkit-tanstack-react-start"
import { source } from "@/lib/api/source"
import { readCapped } from "@/lib/body"
import { ownerFrom } from "@/lib/tenant"

/**
 * Same-origin door to `apps/api`'s `POST /palettes/from-logo`. The api
 * validates the body; only the session cookie travels with it.
 */

/** One logo id, with room to spare. */
const BODY_CAP = 1024

const NO_SESSION = "This request carries no session we can read."

const refuse = (status: number, error: string) =>
  Response.json({ error }, { status })

export const Route = createFileRoute("/api/palettes/from-logo")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!ownerFrom(await getAuth())) return refuse(401, NO_SESSION)
        const body = await readCapped(request, BODY_CAP)
        if (body === null) return refuse(413, "Send one logo at a time.")
        return (await source.logoPalettes(body)) ?? refuse(401, NO_SESSION)
      },
    },
  },
})
