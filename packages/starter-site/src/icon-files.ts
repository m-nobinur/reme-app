import { createHash } from "node:crypto"
import { MARK_PNGS, markColours, markPng, siteMark } from "./favicon"
import { site } from "./site-config"

export type IconFile = {
  /** Where the page links it: under `_astro/`, named by its content, so a browser may keep it for good. */
  path: string
  type: string
  body: string | Uint8Array<ArrayBuffer>
}

const named = (
  name: string,
  ext: string,
  type: string,
  body: IconFile["body"]
) => {
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 8)
  return [
    `${name}.${ext}`,
    { path: `/_astro/${name}.${hash}.${ext}`, type, body },
  ] as const
}

const build = async () => {
  const svg = await siteMark(site)
  const { paper } = markColours(site.palette, site.brandColor)
  const pngs = await Promise.all(
    Object.entries(MARK_PNGS).map(async ([name, size]) =>
      // Only the tab icon keeps its rounded corners; the home-screen icons are
      // full squares the device masks itself.
      named(
        name,
        "png",
        "image/png",
        await markPng(svg, size, paper, size > 32)
      )
    )
  )
  return Object.fromEntries([
    named("favicon", "svg", "image/svg+xml", svg),
    ...pngs,
  ]) as Record<string, IconFile>
}

let icons: ReturnType<typeof build> | undefined

/** The favicon set by its unhashed file name (`favicon.svg`, `icon-192.png`), each with the hashed path it is served at. See src/favicon.ts. */
export const iconFiles = () => {
  icons ??= build()
  return icons
}
