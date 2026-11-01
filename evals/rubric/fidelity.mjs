/**
 * Change fidelity (design §6): did a briefed change do what its brief said,
 * there and nowhere else, with the owner's words as they gave them? Scored
 * from what the pipeline recorded and the preview served, never from the
 * builder's account.
 */

/** Text as a reader compares it: curly quotes, spacing and case aside. */
export const fold = (text) =>
  text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()

/** What a visitor can read on a built page. */
export const visibleText = (html) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")

/**
 * What a change's acceptance checks hold against it. A check the judge
 * decided false is a problem; one it could not decide (null) is neither
 * passed nor failed, so it counts for nothing, but a change none of whose
 * checks were decided has no verdict at all.
 */
export function checkProblems(checks = []) {
  if (checks.length === 0) return ["no acceptance check was judged"]
  const problems = checks
    .filter((c) => c.passed === false)
    .map((c) => `check failed: ${c.check} (${c.why})`)
  if (checks.every((c) => typeof c.passed !== "boolean"))
    problems.push("no acceptance check could be decided")
  return problems
}

/**
 * One change's score. `checks` are the last `change.checked` verdicts,
 * `blocks` the report's block records, `pages` the preview's HTML by route.
 * `verbatim` is the owner's own text, when the request gave some. Pages the
 * brief does not target may change only as the brief's dependents allow
 * (`also`).
 */
export function fidelity({
  brief,
  checks = [],
  blocks = [],
  pages = {},
  verbatim,
  also = [],
}) {
  const problems = checkProblems(checks)
  const targeted = new Set([...brief.targets.map((t) => t.page), ...also])
  const off = [...new Set(blocks.map((b) => b.page))].filter(
    (p) => targeted.size > 0 && !targeted.has(p)
  )
  if (off.length > 0) problems.push(`changed off target: ${off.join(", ")}`)
  if (verbatim) {
    const seen = Object.values(pages).some((html) =>
      fold(visibleText(html)).includes(fold(verbatim))
    )
    if (!seen) problems.push("the owner's words are not on the page as given")
  }
  return { passed: problems.length === 0, problems }
}
