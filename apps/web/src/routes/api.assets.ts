import { createFileRoute } from "@tanstack/react-router"
import { getAuth } from "@workos/authkit-tanstack-react-start"
import { UPLOAD_MAX_BYTES, UPLOAD_MAX_FILES } from "@workspace/contracts"
import { source } from "@/lib/api/source"
import { ownerFrom } from "@/lib/tenant"

/**
 * The upload card's same-origin door to `apps/api`'s `POST /assets`. The
 * multipart body streams through unread, so a dozen photos never sit in
 * this Worker's memory; the api sniffs and caps each file. Only the session
 * cookie and the press's idempotency key travel with it, and the answer
 * comes back untouched.
 */

/** Every photo at its cap, and room for the multipart framing. */
const BODY_CAP = UPLOAD_MAX_FILES * UPLOAD_MAX_BYTES + 1024 * 1024

const refuse = (status: number, error: string) =>
  Response.json({ error }, { status })

export const Route = createFileRoute("/api/assets")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!ownerFrom(await getAuth())) {
          return refuse(401, "This request carries no session we can read.")
        }
        // A declared length, so the cap holds before a byte is read.
        const length = Number(request.headers.get("content-length") ?? "")
        if (!Number.isInteger(length) || length <= 0 || length > BODY_CAP) {
          return refuse(
            413,
            "These photos are too large to send together. Send fewer at once."
          )
        }
        const type = request.headers.get("content-type") ?? ""
        if (!type.startsWith("multipart/form-data") || !request.body) {
          return refuse(400, "Choose photos to upload first.")
        }
        const key =
          request.headers.get("idempotency-key") ?? crypto.randomUUID()
        return (
          (await source.assets({ body: request.body, type, length, key })) ??
          refuse(401, "This request carries no session we can read.")
        )
      },
    },
  },
})
