import type { APIRoute } from "astro"
import { iconFiles } from "../icon-files"

// A rest route, since Astro skips any folder in src/pages that starts with "_".
export const getStaticPaths = async () =>
  Object.values(await iconFiles()).map(({ path }) => ({
    params: { icon: path.slice(1) },
  }))

/** Each icon the head and the web manifest name, at its hashed path. See src/icon-files.ts. */
export const GET: APIRoute = async ({ params }) => {
  const icon = Object.values(await iconFiles()).find(
    ({ path }) => path === `/${params.icon}`
  )
  return new Response(icon?.body, {
    status: icon ? 200 : 404,
    headers: { "Content-Type": icon?.type ?? "text/plain" },
  })
}
