import type { APIRoute } from "astro"
import { routes } from "../routes"

const xmlEscape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** Each page's last change by route, as a date; the platform writes it before every build. */
const lastmod =
  Object.values(
    import.meta.glob<{ default: Record<string, string> }>(
      "../content/lastmod.json",
      { eager: true }
    )
  )[0]?.default ?? {}

// A sitemap names absolute URLs, so it lists pages only when the build was
// given the site's origin (`astro build --site https://...`).
export const GET: APIRoute = ({ site }) => {
  const urls = site
    ? routes.map((path) => {
        const date = lastmod[path]
        return `  <url><loc>${xmlEscape(new URL(path, site).href)}</loc>${
          date && /^\d{4}-\d{2}-\d{2}$/.test(date)
            ? `<lastmod>${date}</lastmod>`
            : ""
        }</url>\n`
      })
    : []
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("")}</urlset>\n`,
    { headers: { "Content-Type": "application/xml; charset=utf-8" } }
  )
}
