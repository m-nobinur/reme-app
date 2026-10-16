/**
 * The design rubric (EV2): twelve rules the builder is given and ten slop
 * tells, as data, and the scoring of a critic's verdict on them. The critic
 * is a model, so its output is checked for shape before it is scored: a rule
 * it skipped, an id it invented or a failure with no node is a problem the
 * caller sees, and a skipped check counts against the site, never for it.
 * The rules are `vs-visual-system.md`'s, the same list `developer-rules.ts`
 * teaches; the tells are EV2's.
 */

export const RULES = [
  {
    id: "fonts",
    text: "Two font families at most; display at weight 500, at size",
  },
  { id: "eyebrow", text: "An eyebrow above every h2" },
  {
    id: "accent",
    text: "Accent the last word or clause of a headline, never the whole line",
  },
  {
    id: "one_hue",
    text: "One hue plus its tints; photos carry the rest of the colour",
  },
  {
    id: "neutrals",
    text: "Neutrals lean toward the hue; no pure white, black or grey",
  },
  { id: "hairlines", text: "Hairlines divide; shadows are rare and soft" },
  { id: "numbered", text: "Processes and lists are numbered 01, 02, 03" },
  { id: "overlay", text: "Every image carries at most one overlay with copy" },
  {
    id: "arrows",
    text: "Every secondary link has an arrow that moves on hover",
  },
  {
    id: "rhythm",
    text: "Section backgrounds alternate so the page has a rhythm",
  },
  {
    id: "brevity",
    text: "Headlines 4 to 9 words, none repeated on the site; body copy as full as the brief asks; one CTA wording repeated",
  },
  {
    id: "no_invented_proof",
    text: "No social proof the facts do not hold; an empty testimonials section is left out",
  },
] as const

export const TELLS = [
  { id: "centred", text: "Everything is centred" },
  { id: "purple_gradient", text: "A purple gradient" },
  {
    id: "generic_headings",
    text: 'Generic headings ("Our services", "Why choose us")',
  },
  { id: "emoji_icons", text: "Emoji used as icons" },
  {
    id: "identical_cards",
    text: "Three identical cards with an icon each and no photo",
  },
  { id: "grey_neutrals", text: "Pure grey neutrals" },
  {
    id: "cta_missing_in_hero",
    text: "The page's CTA wording is missing from the hero",
  },
  {
    id: "unbacked_testimonials",
    text: "Testimonials with no fact behind them",
  },
  { id: "stock_copy", text: "Stock-feeling copy that would fit any business" },
  { id: "many_families", text: "More than two font families" },
] as const

export type RuleId = (typeof RULES)[number]["id"]
export type TellId = (typeof TELLS)[number]["id"]

/** What the critic returns: every rule pass or fail, every tell present or not, each failure with its node. */
export type Verdict = {
  rules: { id: RuleId; pass: boolean; node?: string | null }[]
  tells: { id: TellId; present: boolean; node?: string | null }[]
}

export type Failure = {
  kind: "rule" | "tell"
  id: string
  text: string
  node: string | null
}

export type Score = {
  /** Checks passed over checks asked, 0 to 100. */
  score: number
  /** At most `allowed` failures. Zero until EV1's baseline sets the line. */
  passed: boolean
  failures: Failure[]
  /** Ways the critic's output was not what was asked; each also counts as a failure. */
  problems: string[]
}

const TOTAL = RULES.length + TELLS.length

type Row = { id?: unknown; pass?: unknown; present?: unknown; node?: unknown }

export function scoreRubric(output: unknown, allowed = 0): Score {
  const failures: Failure[] = []
  const problems: string[] = []
  const section = (
    kind: "rule" | "tell",
    asked: readonly { id: string; text: string }[],
    key: "rules" | "tells",
    flag: "pass" | "present"
  ) => {
    const rows = (output as Record<string, unknown> | null)?.[key]
    const given = new Map<string, Row>()
    for (const row of Array.isArray(rows) ? (rows as Row[]) : []) {
      const id = String(row?.id)
      if (!asked.some((a) => a.id === id))
        problems.push(`unknown ${kind} ${id}`)
      else if (given.has(id)) problems.push(`${kind} ${id} given twice`)
      else given.set(id, row)
    }
    for (const { id, text } of asked) {
      const row = given.get(id)
      const value = row?.[flag]
      if (typeof value !== "boolean") {
        problems.push(`${kind} ${id} was not answered`)
        failures.push({ kind, id, text, node: null })
        continue
      }
      if (flag === "pass" ? value : !value) continue
      const node = typeof row?.node === "string" && row.node ? row.node : null
      if (!node) problems.push(`${kind} ${id} failed with no node`)
      failures.push({ kind, id, text, node })
    }
  }
  section("rule", RULES, "rules", "pass")
  section("tell", TELLS, "tells", "present")
  return {
    score: Math.round(((TOTAL - failures.length) / TOTAL) * 100),
    passed: failures.length <= allowed,
    failures,
    problems,
  }
}
