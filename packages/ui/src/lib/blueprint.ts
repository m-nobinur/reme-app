import {
  type Blueprint,
  FONT_PAIRS,
  PAGES,
  PALETTES,
  type SectionKind,
} from "@workspace/contracts"
import { shade } from "@workspace/ui/lib/colour"

/**
 * What the Blueprint card says, drawn from the plan as the planner wrote it:
 * the four colours of its palette, its pair, its pages in section order and
 * which photos will be made. Words are fixed strings here, never the model's,
 * except the features, the planner's own plain-language lines.
 */

/** The channel values a brand colour is moved towards for the paper, tint and ink stops. */
const [LIGHT, DARK] = [255, 0]

const SECTION_LABEL: Record<SectionKind, string> = {
  hero: "Hero",
  trust_strip: "Trust strip",
  service_cards: "Services",
  value_props: "Why us",
  steps: "How it works",
  about: "About",
  testimonials: "Reviews",
  gallery: "Gallery",
  service_area: "Areas covered",
  faq: "FAQ",
  cta_band: "Call to action",
  contact: "Contact",
  quote_form: "Quote form",
}

const pageLabel = (id: string) => PAGES.find((p) => p.id === id)?.label ?? id

/** `calm_daylight` as "Calm daylight". */
export const directionLabel = (id: string) =>
  `${id.charAt(0).toUpperCase()}${id.slice(1).replaceAll("_", " ")}`

/**
 * Paper, tint, primary and ink. A preset is the contracts' own four; the
 * owner's own colour has only the one, so the others are shades of it, as a
 * strip to show the direction and not the exact roles the starter derives.
 */
export function paletteStops(palette: Blueprint["palette"]): string[] {
  if (palette.kind === "brand") {
    const { brand } = palette
    return [
      shade(brand, LIGHT, 0.96),
      shade(brand, LIGHT, 0.85),
      brand,
      shade(brand, DARK, 0.8),
    ]
  }
  return [...(PALETTES.find((p) => p.id === palette.id)?.swatches ?? [])]
}

export const paletteName = (palette: Blueprint["palette"]) =>
  palette.kind === "brand"
    ? `Your colour ${palette.brand}`
    : (PALETTES.find((p) => p.id === palette.id)?.label ?? palette.id)

export function pairOfBlueprint(id: Blueprint["fonts"]) {
  const pair = FONT_PAIRS.find((p) => p.id === id)
  return {
    label: pair?.label ?? id,
    display: pair?.display.family ?? "",
    body: pair?.body.family ?? "",
    weight: pair?.display.weights[0] ?? 400,
  }
}

export type PageRow = { key: string; label: string; sections: string[] }

export const pageRows = (b: Blueprint): PageRow[] =>
  b.pages.map(({ page, sections }) => ({
    key: `page:${page}`,
    label: pageLabel(page),
    sections: sections.map((s) => SECTION_LABEL[s.kind]),
  }))

/** The photos of the plan: how many are the owner's, and which will be made. */
export function photoRows(b: Blueprint) {
  const where = (i: Blueprint["images"][number]) => {
    const [page, section] = [pageLabel(i.page), SECTION_LABEL[i.section]]
    return page === section ? page : `${page} ${section.toLowerCase()}`
  }
  return {
    uploaded: b.images.filter((i) => i.source === "upload").length,
    generated: b.images.filter((i) => i.source === "generated").map(where),
  }
}

/** The line under the pair: how many photos are made, and where, to a few. */
export function generatedLine(b: Blueprint): string {
  const { uploaded, generated } = photoRows(b)
  if (generated.length === 0) {
    return uploaded > 0
      ? "Every photo is one of yours."
      : "This plan has no photos."
  }
  const shown = generated.slice(0, 3).join(", ")
  const more = generated.length > 3 ? ` and ${generated.length - 3} more` : ""
  const own = uploaded > 0 ? ` ${uploaded} are yours.` : ""
  return `${generated.length} photo${generated.length === 1 ? "" : "s"} will be made for you: ${shown}${more}.${own}`
}

/**
 * The rows of `next` that differ from `previous`, by key: `feature:<text>`,
 * `direction`, `palette`, `fonts`, `photos`, `page:<id>`. Empty with no
 * previous plan, so a first plan highlights nothing.
 */
export function changedRows(
  previous: Blueprint | null | undefined,
  next: Blueprint
): Set<string> {
  const changed = new Set<string>()
  if (!previous) return changed
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b)
  for (const feature of next.features) {
    if (!previous.features.includes(feature)) changed.add(`feature:${feature}`)
  }
  if (previous.direction !== next.direction) changed.add("direction")
  if (!same(previous.palette, next.palette)) changed.add("palette")
  if (previous.fonts !== next.fonts) changed.add("fonts")
  if (!same(previous.images, next.images)) changed.add("photos")
  for (const page of next.pages) {
    const before = previous.pages.find((p) => p.page === page.page)
    if (!same(before, page)) changed.add(`page:${page.page}`)
  }
  return changed
}

/** The words the composer starts with after "Change something". */
export const CHANGE_PREFIX = "Change the plan: "

/** What the composer suggests while a plan waits: a message sent then is the owner's change to it. */
export const PLAN_CHANGES_PLACEHOLDER = "Say what to change about this plan…"

/** Whether these parts, a message's, hold a plan still waiting on the owner. */
export const waitsOnBlueprint = (parts: readonly object[] | undefined) =>
  (parts ?? []).some((part) => {
    const p = part as {
      type?: string
      toolName?: string
      result?: unknown
      isError?: boolean
    }
    return (
      p.type === "tool-call" &&
      p.toolName === "review_blueprint" &&
      p.result === undefined &&
      !p.isError
    )
  })
