import type { GateResult } from "@workspace/contracts"
import { parse } from "parse5"
import { resolveSitePath } from "./site-path.ts"

/**
 * The size gate on a tenant revision (§8.5): the starter's own `size-budget.json`
 * line, plus the font line (VS1) and the image lines (IG3), measured on the
 * built home page. The same numbers the starter's tests hold itself to, so a
 * site the builder changed cannot ship heavier than the starter was allowed.
 */

/** From `size-budget.json`. Only `limit`: a tenant's `baseline` is the starter's, not theirs. */
export type SizeBudget = { limit: number }

/** VS1: at most four font files and 120 KB of them on the home page. */
export const FONT_FILES = 4
export const FONT_BYTES = 120 * 1024
/** IG3: the hero at 1280 px, any other image and all of them on a phone. */
export const HERO_BYTES = 180 * 1024
export const IMAGE_BYTES = 90 * 1024
export const IMAGES_BYTES = 700 * 1024
/** A phone: 390 css px at 2x asks for a 780 px candidate. */
const PHONE = 390 * 2
const HERO_WIDTH = 1280

type El = {
  tagName?: string
  attrs?: { name: string; value: string }[]
  childNodes?: El[]
  content?: { childNodes?: El[] }
}
type Tag = {
  tag: string
  attrs: Record<string, string | undefined>
  parent: string
}

function elements(html: string): Tag[] {
  const out: Tag[] = []
  const walk = (node: El, parent: string) => {
    for (const child of node.childNodes ?? node.content?.childNodes ?? []) {
      if (!child.tagName) continue
      out.push({
        tag: child.tagName,
        attrs: Object.fromEntries(
          (child.attrs ?? []).map((a) => [a.name, a.value])
        ),
        parent,
      })
      walk(child, child.tagName)
    }
  }
  walk(parse(html) as unknown as El, "")
  return out
}

type Candidate = { url: string; width: number }
const candidates = (srcset = ""): Candidate[] =>
  srcset
    .split(",")
    .map((c) => c.trim().split(/\s+/))
    .filter(([url]) => url)
    .map(([url, w]) => ({
      url: url ?? "",
      width: Number.parseInt(w ?? "", 10) || 0,
    }))

const gzipped = async (bytes: Uint8Array) =>
  (
    await new Response(
      new Blob([new Uint8Array(bytes)])
        .stream()
        .pipeThrough(new CompressionStream("gzip"))
    ).arrayBuffer()
  ).byteLength

const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`

/**
 * The home page's weight against the budget. `limit` counts what a visitor
 * downloads of text: the page plus its same-origin stylesheets, scripts and
 * SVG, gzipped. Fonts and photos are budgeted on their own lines, as the
 * starter does; a file the manifest does not list is the links gate's to name.
 */
export async function checkSize(
  files: Record<string, string>,
  read: (file: string) => Promise<Uint8Array | null>,
  budget: SizeBudget
): Promise<GateResult> {
  const fail = (message: string, node: string | null = null): GateResult => ({
    gate: "size",
    passed: false,
    evidence_key: null,
    offending_node: node,
    message,
  })
  if (!Number.isFinite(budget.limit) || budget.limit <= 0)
    return fail("the size budget has no usable limit")
  const html = await read("index.html")
  if (!html) return fail("the build has no index.html to measure")
  const tags = elements(new TextDecoder().decode(html))
  const fileOf = (url: string, from = "") => {
    if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(url)) return null
    const path = new URL(url, `https://site.invalid/${from}`).pathname
    return resolveSitePath(path, files)
  }
  // `read` is the caller's cache: the build gate already read every file.
  const size = async (file: string) => (await read(file))?.byteLength ?? 0

  const text = new Set<string>(["index.html"])
  for (const t of tags) {
    const url =
      t.tag === "script"
        ? t.attrs.src
        : t.tag === "link" && /stylesheet/.test(t.attrs.rel ?? "")
          ? t.attrs.href
          : t.tag === "img" && /\.svg$/i.test(t.attrs.src ?? "")
            ? t.attrs.src
            : undefined
    const file = url ? fileOf(url) : null
    if (file) text.add(file)
  }
  let gzip = 0
  const fonts = new Set<string>()
  for (const file of text) {
    const bytes = await read(file)
    if (!bytes) continue
    gzip += await gzipped(bytes)
    if (file.endsWith(".css"))
      for (const [, url] of new TextDecoder()
        .decode(bytes)
        .matchAll(/url\(\s*["']?([^"')]+\.woff2)["']?\s*\)/g)) {
        const font = fileOf(url ?? "", file)
        if (font) fonts.add(font)
      }
  }
  // Preloaded faces count even when no stylesheet we read names them.
  for (const t of tags)
    if (t.tag === "link" && t.attrs.as === "font") {
      const font = fileOf(t.attrs.href ?? "")
      if (font) fonts.add(font)
    }
  if (gzip > budget.limit)
    return fail(
      `the home page is ${kib(gzip)} gzipped, over the ${kib(budget.limit)} budget by ${kib(gzip - budget.limit)}`,
      "index.html"
    )

  let fontBytes = 0
  for (const font of fonts) fontBytes += await size(font)
  if (fonts.size > FONT_FILES || fontBytes > FONT_BYTES)
    return fail(
      `the home page loads ${fonts.size} font files, ${kib(fontBytes)}; the line is ${FONT_FILES} files and ${kib(FONT_BYTES)}`,
      [...fonts][0] ?? null
    )

  // Each <picture> downloads one AVIF candidate; an <img> outside one, its src.
  const images: { file: string; bytes: number; hero: boolean }[] = []
  for (const [i, t] of tags.entries()) {
    if (t.tag === "source" && t.attrs.type === "image/avif") {
      const next = tags.slice(i + 1).find((e) => e.tag === "img")
      const all = candidates(t.attrs.srcset)
      const isHero = next?.attrs.fetchpriority === "high"
      const want = isHero ? HERO_WIDTH : PHONE
      const pick = all.find((c) => c.width >= want) ?? all.at(-1)
      const file = pick && fileOf(pick.url)
      if (file) images.push({ file, bytes: await size(file), hero: isHero })
    } else if (
      t.tag === "img" &&
      t.parent !== "picture" &&
      !/\.svg$/i.test(t.attrs.src ?? "")
    ) {
      const file = fileOf(t.attrs.src ?? "")
      if (file)
        images.push({
          file,
          bytes: await size(file),
          hero: t.attrs.fetchpriority === "high",
        })
    }
  }
  for (const image of images) {
    const line = image.hero ? HERO_BYTES : IMAGE_BYTES
    if (image.bytes > line)
      return fail(
        `${image.file} is ${kib(image.bytes)}; ${image.hero ? "the hero" : "an image"} may be ${kib(line)}`,
        image.file
      )
  }
  const total = images.reduce((sum, i) => sum + i.bytes, 0)
  if (total > IMAGES_BYTES)
    return fail(
      `the home page's ${images.length} images are ${kib(total)} on a phone; the line is ${kib(IMAGES_BYTES)}`,
      "index.html"
    )

  return {
    gate: "size",
    passed: true,
    evidence_key: null,
    offending_node: null,
    message: `home ${kib(gzip)} gzip, ${fonts.size} fonts ${kib(fontBytes)}, ${images.length} images ${kib(total)} on a phone`,
  }
}
