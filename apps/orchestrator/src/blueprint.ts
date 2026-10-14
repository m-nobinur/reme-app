import {
  type Blueprint,
  type ImageSlot,
  PALETTES,
  type PageId,
  type SectionKind,
} from "@workspace/contracts"

import { generatedPath } from "./images.ts"
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

/** Where each image slot's picture is, as its site field holds it. */
function slotLine(slot: ImageSlot, files: readonly PhotoFile[]): string {
  const where = `${slot.id}: ${slot.page} ${slot.section}, ${slot.aspect}`
  if (slot.source === "upload") {
    return `${where}, the owner's photo ${slot.asset_id}. Alt: ${slot.alt}`
  }
  const file = files.find((f) => f.slot_id === slot.id)
  return file
    ? `${where}, generated: set its field to "${generatedPath(slot.id, file.content_type)}". Alt: ${slot.alt}`
    : `${where}, generated but not made: leave its field empty, so the section takes its no-image form.`
}

/** The Blueprint as the Developer reads it, after the facts (instructions.ts). */
export function blueprintLines(
  plan: Blueprint,
  files: readonly PhotoFile[] = []
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
