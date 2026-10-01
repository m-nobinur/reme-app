/**
 * Every page route, read from the page files themselves. Navigation, the
 * sitemap and robots.txt all come from this list, so a page left out of
 * src/pages leaves all three at once, and a page added reaches the sitemap
 * without anyone editing it.
 */
import { site } from "./site-config"

const files = Object.keys(import.meta.glob("./pages/**/*.astro"))

export const routes: string[] = files
  .filter((file) => !file.includes("["))
  .map((file) => file.slice("./pages".length).replace(/(index)?\.astro$/, ""))
  .map((path) => (path.endsWith("/") ? path : `${path}/`))
  .filter((path) => path !== "/404/")
  .sort()

export const hasRoute = (path: string): boolean => routes.includes(path)

/**
 * The navigation both the header and the footer render, in menu order: a
 * page that exists and whose label field is set. One list, so the two agree.
 */
export const navLinks: { href: string; label: string }[] = [
  { href: "/", label: site.navHome },
  { href: "/services/", label: site.navServices },
  { href: "/service-area/", label: site.navServiceArea },
  { href: "/about/", label: site.navAbout },
  { href: "/contact/", label: site.navContact },
  { href: "/quote/", label: site.navQuote },
  { href: "/booking/", label: site.navBooking },
].filter((link) => link.label && hasRoute(link.href))

/**
 * The one action a call to action points at: the quote page, the contact
 * page, or nothing when the site has neither.
 */
export const primaryAction: { href: string; label: string } | undefined = [
  { href: "/quote/", label: site.navQuote },
  { href: "/contact/", label: site.navContact },
].find((link) => link.label && hasRoute(link.href))
