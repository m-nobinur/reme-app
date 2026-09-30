/**
 * The layout and type the owner picked in onboarding, read from
 * `site.template` and `site.font`. The ids and stacks are the contract's
 * TEMPLATES and FONTS; this file copies them because it imports nothing, and
 * the starter's tests fail when the copies drift.
 */

/** The layouts, the first the default. Styles key off `data-template`. */
export const TEMPLATES = ["classic", "modern", "bold"] as const
export type Template = (typeof TEMPLATES)[number]

/** The layout a value names, or the default for anything else. */
export const templateOf = (value: string): Template =>
  TEMPLATES.find((id) => id === value.trim()) ?? "classic"

/** System stacks only: the site ships no font files and no script. */
export const FONTS: Record<string, string> = {
  clean_sans: "system-ui, sans-serif",
  classic_serif: "ui-serif, Georgia, serif",
  soft_rounded: "ui-rounded, system-ui, sans-serif",
}

/** The stack as one CSS rule for the page head, or an empty string. */
export function fontTheme(value: string): string {
  const id = value.trim()
  const family = Object.hasOwn(FONTS, id) ? FONTS[id] : undefined
  if (!family) return ""
  return `html:root{--font-sans:${family};--font-display:${family}}`
}
