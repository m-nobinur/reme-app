import type {
  Blueprint,
  FactRecord,
  GateResult,
  ImageSlot,
} from "@workspace/contracts"

const failed = (node: string, message: string): GateResult => ({
  gate: "build",
  passed: false,
  evidence_key: null,
  offending_node: node,
  message,
})

const EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
}

/**
 * The owner's logo is the favicon: the starter draws the logo's symbol in
 * the mark, or marks a logo with none (a wordmark) `data-logo="no-symbol"`
 * and draws the initial. A favicon with neither, on a site whose owner has
 * a logo, never found the logo file. Null when it passes or there is no logo.
 */
export async function checkFavicon(
  facts: readonly FactRecord[],
  files: Record<string, string>,
  read: (file: string) => Promise<Uint8Array | null>
): Promise<GateResult | null> {
  const items = (
    facts.find((f) => f.key === "media.uploads")?.value as
      | { items?: { id: string; use?: string; content_type?: string }[] }
      | undefined
  )?.items
  const logo = items?.find((a) => a.use === "logo")
  if (!logo) return null
  const favicon = Object.keys(files).find((f) =>
    /^_astro\/favicon\.[^/]*\.svg$/.test(f)
  )
  const bytes = favicon ? await read(favicon) : null
  const svg = bytes ? new TextDecoder().decode(bytes) : ""
  if (/<image\b/.test(svg) || svg.includes('data-logo="no-symbol"')) return null
  return failed(
    favicon ?? "favicon",
    `the owner has a logo and the favicon does not draw it: set site.logo in src/site-config.ts to "/uploads/${logo.id}.${EXTENSION[logo.content_type ?? ""] ?? "png"}", the file the build placed`
  )
}

/**
 * The site fields a slot's photo and its alt go in, or null for a slot no
 * field shows. `gallery` is the slot's place (1 to 3) among the gallery's.
 * The closing band's photo is decoration, so it has no alt.
 */
export function slotFields(
  slot: Pick<ImageSlot, "id" | "page" | "section">,
  gallery = 0
): { src: string; alt: string | null } | null {
  const header = /^service_(\d)_hero$/.exec(slot.id)?.[1]
  const card = /^service_(\d)_card$/.exec(slot.id)?.[1]
  const pair = (src: string) => ({ src, alt: `${src}Alt` })
  if (header) return pair(`service${header}HeaderImage`)
  if (card) return pair(`service${card}Image`)
  if (slot.section === "hero" && slot.page === "home") return pair("heroImage")
  if (slot.section === "hero" && ["about", "contact"].includes(slot.page))
    return pair(`${slot.page}Image`)
  if (slot.section === "cta_band") return { src: "ctaImage", alt: null }
  if (slot.section === "gallery" && gallery >= 1 && gallery <= 3)
    return { src: `photo${gallery}Src`, alt: `photo${gallery}Alt` }
  return null
}

/**
 * Every photo the plan holds is in the build: Astro names an encoded image
 * after its source file, `_astro/<slot id>.<hash>.webp` for a generated one
 * and `_astro/<asset id>.<hash>.webp` for an upload, and the starter drops
 * every image no page names. The photo step leaves a slot that fell back out
 * of the plan, so a slot still there with no file was made and not shown.
 * Null when none is missing.
 */
export function checkPlannedPhotos(
  plan: Pick<Blueprint, "images">,
  files: Record<string, string>
): GateResult | null {
  const gallery = plan.images.filter((s) => s.section === "gallery")
  const built = Object.keys(files)
  const missing = plan.images.flatMap((slot) => {
    const at = slotFields(slot, gallery.indexOf(slot) + 1)
    if (!at) return []
    const name = slot.source === "upload" ? slot.asset_id : slot.id
    return built.some((f) => f.startsWith(`_astro/${name}.`))
      ? []
      : [{ slot, field: at.src }]
  })
  const [first] = missing
  if (!first) return null
  return failed(
    first.slot.id,
    `the Blueprint's photo${missing.length > 1 ? "s" : ""} ${missing.map((m) => m.slot.id).join(", ")} ${missing.length > 1 ? "are" : "is"} not in the build: set ${missing.map((m) => `site.${m.field}`).join(", ")} in src/site-config.ts to the path the Blueprint gives, with its alt, and keep the section that shows it`
  )
}
