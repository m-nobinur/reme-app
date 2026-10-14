/**
 * The layout the owner picked in onboarding, read from `site.template`. The
 * ids are the contract's TEMPLATES; this file copies them because it imports
 * nothing, and the starter's tests fail when the copies drift. The type is
 * src/fonts.ts.
 */

/** The layouts, the first the default. Styles key off `data-template`. */
export const TEMPLATES = ["classic", "modern", "bold"] as const
export type Template = (typeof TEMPLATES)[number]

/** The layout a value names, or the default for anything else. */
export const templateOf = (value: string): Template =>
  TEMPLATES.find((id) => id === value.trim()) ?? "classic"

/**
 * The home hero each template had before section variants, so an owner's
 * pick keeps its look until directions replace templates.
 */
export const HERO_OF = {
  classic: "split_frame",
  modern: "dark_center",
  bold: "text_led",
} as const satisfies Record<Template, string>
