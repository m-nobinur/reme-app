import { createFileRoute } from "@tanstack/react-router"
import { relayPicture } from "@/lib/api/picture"
import { source } from "@/lib/api/source"

/** The version cards' door to `apps/api`'s `GET /revisions/:id/:picture`: a version's home page or icon. */
export const Route = createFileRoute("/api/revisions/$id/$picture")({
  server: {
    handlers: {
      GET: ({ params }) =>
        relayPicture(() => source.revisionPicture(params.id, params.picture)),
    },
  },
})
