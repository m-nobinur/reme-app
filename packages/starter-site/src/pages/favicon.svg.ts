import type { APIRoute } from "astro"
import { siteMark } from "../favicon"
import { site } from "../site-config"

/** The site's mark as its SVG favicon. See src/favicon.ts. */
export const GET: APIRoute = async () =>
  new Response(await siteMark(site), {
    headers: { "Content-Type": "image/svg+xml" },
  })
