import {
  type Blueprint,
  PALETTES,
  type PageId,
  type SectionKind,
} from "@workspace/contracts"

// The Blueprint as the builder reads it (ADR-038). Pure, so the Developer's
// instructions take it without the planner's database and model imports.

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

/** The Blueprint as the Developer reads it, after the facts (instructions.ts). */
export function blueprintLines(plan: Blueprint): string[] {
  const palette =
    plan.palette.kind === "preset"
      ? `the ${plan.palette.id} palette (brand colour ${PALETTES.find((p) => p.id === (plan.palette as { id: string }).id)?.brand ?? "its primary"})`
      : `the owner's own colour ${plan.palette.brand}`
  return [
    "Blueprint, the plan the owner approved. Build exactly this. Where it differs from the owner's choices above on layout, type or colour, the Blueprint wins: it already applies them.",
    `- Direction ${plan.direction}; font pair ${plan.fonts}; ${palette}. Set them through the fields src/site-config.ts gives for direction, font and colour.`,
    `- Voice: ${plan.voice}`,
    "- Set the `layout` export in src/site-config.ts to exactly this, every variant written out; a page not listed is not built:",
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
          "- Image slots (an upload is the owner's photo by asset id; a generated slot is filled by the photo director, or the section takes its no-image variant):",
          ...plan.images.map(
            (slot) =>
              `  - ${slot.id}: ${slot.page} ${slot.section}, ${slot.aspect}, ${slot.source}${slot.source === "upload" ? ` ${slot.asset_id}` : ""}. Alt: ${slot.alt}`
          ),
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
