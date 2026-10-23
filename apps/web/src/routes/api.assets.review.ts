import { createFileRoute } from "@tanstack/react-router"
import { getAuth } from "@workos/authkit-tanstack-react-start"
import { source } from "@/lib/api/source"
import { readCapped } from "@/lib/body"
import { ownerFrom } from "@/lib/tenant"

/**
 * The design tray's same-origin door to `apps/api`'s `POST /assets/review`,
 * which reads the owner's stored photos against the photo needs. The body
 * goes through unparsed for the api to validate; only the session cookie
 * and the press's idempotency key travel with it, and the answer comes back
 * untouched.
 */

/** A dozen photo ids, with room to spare. */
const BODY_CAP = 16 * 1024

const refuse = (status: number, error: string) =>
  Response.json({ error }, { status })

export const Route = createFileRoute("/api/assets/review")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!ownerFrom(await getAuth())) {
          return refuse(401, "This request carries no session we can read.")
        }
        const body = await readCapped(request, BODY_CAP)
        if (body === null) return refuse(413, "Send fewer photos at once.")
        const key =
          request.headers.get("idempotency-key") ?? crypto.randomUUID()
        return (
          (await source.reviewPhotos(body, key)) ??
          refuse(401, "This request carries no session we can read.")
        )
      },
    },
  },
})
