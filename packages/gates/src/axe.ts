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
    violations: { id: string; impact: string | null; targets: string[] }[]
  }[]
}

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
        targets: (list(v?.targets) ?? []).map(String),
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
  const count = result?.pages.reduce((n, p) => n + p.violations.length, 0)
  return gate(
    false,
    `axe found ${count} violation(s); the first is ${rule.id} (${rule.impact ?? "unrated"}) on ${first.path}`,
    `${first.path} ${rule.targets[0] ?? rule.id}`
  )
}
