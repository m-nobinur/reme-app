import { createFileRoute } from "@tanstack/react-router"
import { getAuth } from "@workos/authkit-tanstack-react-start"
import { source } from "@/lib/api/source"
import { ownerFrom } from "@/lib/tenant"

/**
 * The logo page's same-origin door to `apps/api`'s `POST /logos/:id/keep`:
 * a drawn variant or an uploaded file kept as the business's logo. Only the
 * session cookie and the press's idempotency key travel, and the answer
 * comes back untouched.
 */

const refuse = (status: number, error: string) =>
  Response.json({ error }, { status })

const NO_SESSION = "This request carries no session we can read."

export const Route = createFileRoute("/api/logos/$id/keep")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        if (!ownerFrom(await getAuth())) return refuse(401, NO_SESSION)
        const key =
          request.headers.get("idempotency-key") ?? crypto.randomUUID()
        return (
          (await source.keepLogo(params.id, key)) ?? refuse(401, NO_SESSION)
        )
      },
    },
  },
})
