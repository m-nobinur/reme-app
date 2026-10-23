import { createFileRoute } from "@tanstack/react-router"
import { getAuth } from "@workos/authkit-tanstack-react-start"
import { UPLOAD_MAX_BYTES } from "@workspace/contracts"
import { source } from "@/lib/api/source"
import { ownerFrom } from "@/lib/tenant"

/**
 * The palette page's same-origin door to `apps/api`'s
 * `POST /palettes/from-image`. The one picture streams through unread; the
 * api sniffs, caps and reads it and never stores it. Only the session
 * cookie and the press's idempotency key travel with it, and the answer
 * comes back untouched.
 */

/** One picture at its cap, and room for the multipart framing. */
const BODY_CAP = UPLOAD_MAX_BYTES + 64 * 1024

const refuse = (status: number, error: string) =>
  Response.json({ error }, { status })

export const Route = createFileRoute("/api/palettes/from-image")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!ownerFrom(await getAuth())) {
          return refuse(401, "This request carries no session we can read.")
        }
        // A declared length, so the cap holds before a byte is read.
        const length = Number(request.headers.get("content-length") ?? "")
        if (!Number.isInteger(length) || length <= 0 || length > BODY_CAP) {
          return refuse(413, "This picture is too large. Try a smaller one.")
        }
        const type = request.headers.get("content-type") ?? ""
        if (!type.startsWith("multipart/form-data") || !request.body) {
          return refuse(400, "Choose a picture first.")
        }
        const key =
          request.headers.get("idempotency-key") ?? crypto.randomUUID()
        return (
          (await source.paletteFromImage({
            body: request.body,
            type,
            length,
            key,
          })) ?? refuse(401, "This request carries no session we can read.")
        )
      },
    },
  },
})
