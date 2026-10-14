import { createFileRoute } from "@tanstack/react-router"
import { getAuth } from "@workos/authkit-tanstack-react-start"
import { source } from "@/lib/api/source"
import { ownerFrom } from "@/lib/tenant"

/**
 * The panel's and the review card's same-origin door to `apps/api`'s
 * `GET /photos/:id`: a generated photo of the signed-in owner's org. Only the
 * session cookie travels; the api scopes the read to that session's org, and
 * only the picture's type and caching come back with its bytes.
 */
export const Route = createFileRoute("/api/photos/$id")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const answer = ownerFrom(await getAuth())
          ? await source.photo(params.id)
          : null
        if (!answer) return new Response(null, { status: 401 })
        if (!answer.ok) return new Response(null, { status: answer.status })
        const headers = new Headers()
        for (const name of [
          "content-type",
          "cache-control",
          "x-content-type-options",
        ]) {
          const value = answer.headers.get(name)
          if (value) headers.set(name, value)
        }
        return new Response(answer.body, { headers })
      },
    },
  },
})
