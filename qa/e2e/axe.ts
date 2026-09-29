/**
 * The rule set every page scan runs: WCAG 2.2 AA, plus `best-practice`. The
 * second half matters: axe files `heading-order` as best practice rather than
 * as a WCAG failure, so a page whose outline jumps h1 to h3 passes a
 * WCAG-only scan. That defect reached `/app/approvals` past a green component
 * catalog, and was measured both ways before `best-practice` was added.
 */
export const AXE_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
  "best-practice",
]
