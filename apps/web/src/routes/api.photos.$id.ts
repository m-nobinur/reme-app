import { createFileRoute } from "@tanstack/react-router"
import { relayPicture } from "@/lib/api/picture"
import { source } from "@/lib/api/source"

/** The panel's and the review card's door to `apps/api`'s `GET /photos/:id`: a generated photo of the owner's org. */
export const Route = createFileRoute("/api/photos/$id")({
  server: {
    handlers: {
      GET: ({ params }) => relayPicture(() => source.photo(params.id)),
    },
  },
})
