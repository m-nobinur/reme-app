import type { CompletionReport, GateResult } from "@workspace/contracts"

/**
 * The accessibility gate (§8.5, EV2): axe-core ran inside the build sandbox
 * against the built site, a few pages at one width, and the report carries
 * its exit code (0 clean, 1 violations, 2 it could not run) and the key of
 * its JSON. A gate that cannot run fails closed, as `types` does: a Worker
 * cannot drive a browser, so what the sandbox reported is what is checked.
 */

/** What `infra/sandbox/astro/axe.mjs` writes: only violations, one entry per rule per page. */
export type AxeResult = {
  pages: {
    path: string
    violations: {
      id: string
      impact: string | null
      help: string
      targets: string[]
      summary: string
      html: string
    }[]
  }[]
}

/** The most violations the failure message spells out; the evidence JSON has them all. */
const DETAILED = 8

/** The JSON is the sandbox's, so its shape is checked rather than trusted. */
export function parseAxe(raw: unknown): AxeResult | null {
  const list = (value: unknown) => (Array.isArray(value) ? value : null)
  const pages = list((raw as AxeResult | null)?.pages)
  if (!pages) return null
  const out: AxeResult["pages"] = []
  for (const page of pages) {
    const violations = list(page?.violations)
    if (typeof page?.path !== "string" || !violations) return null
    out.push({
      path: page.path,
      violations: violations.map((v) => ({
        id: String(v?.id),
        impact: typeof v?.impact === "string" ? v.impact : null,
        help: String(v?.help ?? ""),
        targets: (list(v?.targets) ?? []).map(String),
        summary: String(v?.summary ?? ""),
        html: String(v?.html ?? ""),
      })),
    })
  }
  return { pages: out }
}

export function checkAxe(
  report: Pick<CompletionReport, "checks">,
  result: AxeResult | null
): GateResult {
  const check = report.checks.find((c) => c.check === "axe")
  const gate = (passed: boolean, message: string, node: string | null) => ({
    gate: "a11y" as const,
    passed,
    evidence_key: check?.output_key ?? null,
    offending_node: node,
    message,
  })
  if (!check) return gate(false, "the build sandbox reported no axe run", null)
  if (check.exit_code === 0) {
    const pages = result?.pages.length
    return gate(
      true,
      `axe found no violations${pages ? ` on ${pages} page(s)` : ""}, as reported by the build sandbox`,
      null
    )
  }
  const first = result?.pages.find((p) => p.violations.length > 0)
  const rule = first?.violations[0]
  if (!first || !rule)
    return gate(
      false,
      `axe exited ${check.exit_code} without a result, so the site's accessibility is unchecked`,
      null
    )
  const all = (result?.pages ?? []).flatMap((p) =>
    p.violations.map((v) => ({ path: p.path, ...v }))
  )
  // What the Developer needs to fix it without guessing: rule, impact, page,
  // selectors, axe's own summary and the markup of the first node.
  const detail = all
    .slice(0, DETAILED)
    .map(
      (v) =>
        `- ${v.id} (${v.impact ?? "unrated"}) on ${v.path}: ${v.help}\n  targets: ${v.targets.join(" | ")}\n  ${v.summary}\n  html: ${v.html}`
    )
    .join("\n")
  return gate(
    false,
    `axe found ${all.length} violation(s); the first is ${rule.id} (${rule.impact ?? "unrated"}) on ${first.path}\n${detail}${all.length > DETAILED ? `\n- and ${all.length - DETAILED} more in the evidence` : ""}`,
    `${first.path} ${rule.targets[0] ?? rule.id}`
  )
}
