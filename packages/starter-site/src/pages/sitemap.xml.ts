import type { APIRoute } from "astro"
import { routes } from "../routes"

const xmlEscape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// A sitemap names absolute URLs, so it lists pages only when the build was
// given the site's origin (`astro build --site https://...`).
export const GET: APIRoute = ({ site }) => {
  const urls = site
    ? routes.map(
        (path) =>
          `  <url><loc>${xmlEscape(new URL(path, site).href)}</loc></url>\n`
      )
    : []
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("")}</urlset>\n`,
    { headers: { "Content-Type": "application/xml; charset=utf-8" } }
  )
}
