import { env } from "cloudflare:workers"
import { createFileRoute } from "@tanstack/react-router"

/**
 * Proves the app is served by workerd with its bindings attached: the user
 * agent is the Workers runtime's own, and the value comes back out of the KV
 * binding it was just written to.
 */
export const Route = createFileRoute("/api/runtime")({
  server: {
    handlers: {
      GET: async () => {
        const writtenAt = new Date().toISOString()
        await env.CACHE.put("runtime-probe", writtenAt)
        return Response.json({
          runtime: navigator.userAgent,
          cacheBinding: await env.CACHE.get("runtime-probe"),
        })
      },
    },
  },
})
