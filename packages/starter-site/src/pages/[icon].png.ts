import type { APIRoute } from "astro"
import { MARK_PNGS, markColours, markPng, siteMark } from "../favicon"
import { site } from "../site-config"

export const getStaticPaths = () =>
  Object.keys(MARK_PNGS).map((icon) => ({ params: { icon } }))

/** Each PNG the head and the web manifest name. See src/favicon.ts. */
export const GET: APIRoute = async ({ params }) => {
  const size = MARK_PNGS[params.icon as keyof typeof MARK_PNGS]
  const { paper } = markColours(site.palette, site.brandColor)
  // Only the tab icon keeps its rounded corners; the home-screen icons are
  // full squares the device masks itself.
  const png = await markPng(await siteMark(site), size, paper, size > 32)
  return new Response(png, { headers: { "Content-Type": "image/png" } })
}
