/**
 * The design directions a site can wear: `directions.json`, rows the
 * contract's `DesignDirection` validates (test/directions.test.ts). The first
 * is the default. `site.direction` names one by id, or by the template id a
 * site stored before directions; `LEGACY` copies the contract's
 * `LEGACY_TEMPLATE_DIRECTION` because this file imports nothing outside the
 * starter, and the test fails when the copies drift.
 *
 * The page reads radius, bands and the id (for the ornament) off the root
 * element; a section with no variant of its own in `layout` takes the
 * direction's. Fonts and palette are their own fields, as in the Blueprint.
 */
import DIRECTIONS from "./directions.json"

export type Direction = (typeof DIRECTIONS)[number]
export { DIRECTIONS }

export const LEGACY: Record<string, string> = {
  classic: "fresh_modern",
  modern: "calm_daylight",
  bold: "bold_young",
}

/** The direction a value names, directly or by its old template id; else the first. */
export function directionOf(value: string): Direction {
  const key = value.trim()
  const id = Object.hasOwn(LEGACY, key) ? LEGACY[key] : key
  return (DIRECTIONS.find((each) => each.id === id) ??
    DIRECTIONS[0]) as Direction
}
