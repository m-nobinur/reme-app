import type { APIRoute } from "astro"
import { markColours } from "../favicon"
import { site } from "../site-config"

/** The web manifest: the site's name, colours and icons, for a home screen. */
export const GET: APIRoute = () => {
  const { primary, paper } = markColours(site.palette, site.brandColor)
  const manifest = {
    name: site.businessName,
    short_name: site.businessName,
    start_url: "/",
    display: "browser",
    theme_color: primary,
    background_color: paper,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/favicon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  }
  return new Response(JSON.stringify(manifest), {
    headers: { "Content-Type": "application/manifest+json" },
  })
}
