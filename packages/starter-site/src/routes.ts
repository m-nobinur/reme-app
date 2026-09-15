/**
 * Every page route, read from the page files themselves. Navigation, the
 * sitemap and robots.txt all come from this list, so a page left out of
 * src/pages leaves all three at once, and a page added reaches the sitemap
 * without anyone editing it.
 */
const files = Object.keys(import.meta.glob("./pages/**/*.astro"))

export const routes: string[] = files
  .filter((file) => !file.includes("["))
  .map((file) => file.slice("./pages".length).replace(/(index)?\.astro$/, ""))
  .map((path) => (path.endsWith("/") ? path : `${path}/`))
  .filter((path) => path !== "/404/")
  .sort()

export const hasRoute = (path: string): boolean => routes.includes(path)
