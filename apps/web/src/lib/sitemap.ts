/** The pages anyone may read without signing in; robots.txt keeps crawlers out of the rest. */
const PUBLIC_PAGES = ["/", "/privacy", "/terms"]

/** The sitemap of the public pages on `origin`. */
export const sitemap = (origin: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${PUBLIC_PAGES.map(
    (path) => `<url><loc>${origin}${path}</loc></url>`
  ).join("\n")}\n</urlset>\n`
