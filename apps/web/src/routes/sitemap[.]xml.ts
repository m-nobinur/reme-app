import { createFileRoute } from "@tanstack/react-router"
import { sitemap } from "@/lib/sitemap"

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: async ({ request }) =>
        new Response(sitemap(new URL(request.url).origin), {
          headers: {
            "content-type": "application/xml; charset=utf-8",
            "cache-control": "public, max-age=3600",
          },
        }),
    },
  },
})
