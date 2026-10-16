import {
  type Blueprint,
  type ImageSlot,
  PALETTES,
  type PageId,
  SECTION_VARIANTS,
  type SectionKind,
} from "@workspace/contracts"

import { generatedPath, plannedPath } from "./images.ts"
import type { PhotoFile } from "./photo-step.ts"

// The Blueprint as the builder reads it (ADR-038). Pure, so the Developer's
// instructions take it without the planner's database and model imports.

/** `site.palette`'s six roles, in the order site-config writes them. */
const ROLES = ["paper", "ink", "primary", "tint", "accent", "line"] as const

/**
 * The Blueprint as the starter's `layout` export (VS4): each planned page's
 * sections in order, every variant written out. An inner page's hero needs
 * its variant named, or the starter draws the plain page hero.
 */
export function blueprintLayout(
  plan: Blueprint
): Partial<Record<PageId, { kind: SectionKind; variant: string }[]>> {
  return Object.fromEntries(
    plan.pages.map(({ page, sections }) => [
      page,
      sections.map(({ kind, variant }) => ({ kind, variant })),
    ])
  )
}

/** The site fields a page header's photo and its alt go in, where the slot is one. */
function headerField(slot: ImageSlot): string {
  const header = /^service_(\d)_hero$/.exec(slot.id)?.[1]
  const card = /^service_(\d)_card$/.exec(slot.id)?.[1]
  const field = header
    ? `service${header}HeaderImage`
    : card
      ? `service${card}Image`
      : slot.section === "hero" && ["about", "contact"].includes(slot.page)
        ? `${slot.page}Image`
        : ""
  return field ? ` (site.${field} and site.${field}Alt)` : ""
}

/**
 * Where each image slot's picture is, as its site field holds it. With no
 * `files` the photos are still being drawn while the pages are written, so
 * each slot gets its planned path; `write_pages` corrects the extension or
 * empties the field once they land.
 */
function slotLine(slot: ImageSlot, files?: readonly PhotoFile[]): string {
  const where = `${slot.id}: ${slot.page} ${slot.section}${headerField(slot)}, ${slot.aspect}`
  if (slot.source === "upload") {
    return `${where}, the owner's photo ${slot.asset_id}. Alt: ${slot.alt}`
  }
  if (!files) {
    return `${where}, generated: set its field to "${plannedPath(slot.id)}". Alt: ${slot.alt}`
  }
  const file = files.find((f) => f.slot_id === slot.id)
  return file
    ? `${where}, generated: set its field to "${generatedPath(slot.id, file.content_type)}". Alt: ${slot.alt}`
    : `${where}, generated but not made: leave its field empty, so the section takes its no-image form.`
}

/** The Blueprint as the Developer reads it, after the facts (instructions.ts). */
export function blueprintLines(
  plan: Blueprint,
  files?: readonly PhotoFile[]
): string[] {
  const preset =
    plan.palette.kind === "preset"
      ? PALETTES.find((p) => p.id === (plan.palette as { id: string }).id)
      : undefined
  const colour = preset
    ? `palette to "${ROLES.map((role) => `${role}:${preset[role]}`).join(" ")}" (${preset.id})`
    : `brandColor to ${(plan.palette as { brand: string }).brand}, the owner's own colour, and palette to ""`
  return [
    "Blueprint, the plan the owner approved. Build exactly this. Where it differs from the owner's choices above on layout, type or colour, the Blueprint wins: it already applies them.",
    `- In src/site-config.ts set direction to "${plan.direction}", font to "${plan.fonts}" and ${colour}.`,
    `- Voice: ${plan.voice}`,
    "- Set the `layout` export in src/site-config.ts to exactly this, every variant written out even where the direction would supply it, since the Blueprint already chose each one; a page not listed is not built:",
    JSON.stringify(blueprintLayout(plan)),
    "- The pages are fixed: keep the file in src/pages for every page the layout lists (`service` is src/pages/services/[slug].astro, one page per named service), and delete only starter pages it does not list. Never delete a planned page, whatever the facts; when they are thin, write from the trade's usual practice. The build fails on a planned page it lacks.",
    "- What each section is for:",
    ...plan.pages.flatMap(({ page, sections }) =>
      sections.map(
        (s) =>
          `  - ${page} ${s.kind} (${s.variant}): ${s.purpose}${s.content_notes ? ` Facts: ${s.content_notes}` : ""}`
      )
    ),
    ...(plan.images.length > 0
      ? [
          "- Image slots. A photo the plan dropped is not listed, and its section renders without one:",
          ...plan.images.map((slot) => `  - ${slotLine(slot, files)}`),
        ]
      : []),
    ...(plan.custom_sections?.length
      ? [
          "- Custom sections the plan allows, in src/components/custom/:",
          ...plan.custom_sections.map((c) => `  - ${c.name}: ${c.purpose}`),
        ]
      : []),
    "- What the owner was promised:",
    ...plan.features.map((f) => `  - ${f}`),
  ]
}

/**
 * What a section change needs of the plan (QE4's short prompt): the variants
 * each section kind takes, and, when the site was planned, each page's
 * sections in order with what each is for. A site built before planning has
 * only the first list, and the `layout` export in its site-config is the rest.
 * The owner's words never reach the instructions (§28.3), so the target page
 * cannot be picked here: every page's order and every purpose is listed, one
 * short line each, and the model finds its own.
 */
export function layoutLines(plan: Blueprint | null): string[] {
  return [
    "Layout. The `layout` export in src/site-config.ts lists each page's sections in order. Reorder, add, drop or change a variant by editing that data, and nothing else. The variants each section kind takes:",
    ...Object.entries(SECTION_VARIANTS).map(
      ([kind, variants]) => `  - ${kind}: ${variants.join(", ")}`
    ),
    ...(plan
      ? [
          "The site as last planned and approved. The `layout` export may have moved since, so read it before you edit:",
          ...plan.pages.map(
            ({ page, sections }) =>
              `  - ${page}: ${sections.map((s) => `${s.kind} (${s.variant})`).join(", ")}`
          ),
          "What each section is for:",
          ...plan.pages.flatMap(({ page, sections }) =>
            sections.map((s) => `  - ${page} ${s.kind}: ${s.purpose}`)
          ),
        ]
      : []),
  ]
}
