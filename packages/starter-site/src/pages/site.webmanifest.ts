import type { APIRoute } from "astro"
import { markColours } from "../favicon"
import { iconFiles } from "../icon-files"
import { site } from "../site-config"

/** The web manifest: the site's name, colours and icons, for a home screen. */
export const GET: APIRoute = async () => {
  const { primary, paper } = markColours(site.palette, site.brandColor)
  const icons = await iconFiles()
  const manifest = {
    name: site.businessName,
    short_name: site.businessName,
    start_url: "/",
    display: "browser",
    theme_color: primary,
    background_color: paper,
    icons: [
      { src: icons["icon-192.png"]?.path, sizes: "192x192", type: "image/png" },
      { src: icons["icon-512.png"]?.path, sizes: "512x512", type: "image/png" },
      { src: icons["favicon.svg"]?.path, sizes: "any", type: "image/svg+xml" },
    ],
  }
  return new Response(JSON.stringify(manifest), {
    headers: { "Content-Type": "application/manifest+json" },
  })
}
