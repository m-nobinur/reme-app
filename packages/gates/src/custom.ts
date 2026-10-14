import type { CompletionReport, GateResult } from "@workspace/contracts"

/**
 * The custom-section rules (ADR-038, VS8), as the build sandbox reported
 * them. `packages/starter-site/scripts/custom-sections.mjs` runs in the
 * sandbox and leaves its findings as JSON; this reads the exit code and the
 * JSON the way the axe gate does. It has no gate of its own: the rules are
 * about source, so a failure is the `types` gate's, and a site that never
 * ran the check fails closed like one that never ran `astro check`.
 */

/** The check's name in `CompletionReport.checks`. */
export const CUSTOM_CHECK = "custom sections"

export type CustomFinding = { file: string; rule: string; message: string }

/** The JSON is the sandbox's, so its shape is checked rather than trusted. */
export function parseCustom(raw: unknown): CustomFinding[] | null {
  const list = (raw as { findings?: unknown } | null)?.findings
  if (!Array.isArray(list)) return null
  const found: CustomFinding[] = []
  for (const f of list) {
    if (
      typeof f?.file !== "string" ||
      typeof f?.rule !== "string" ||
      typeof f?.message !== "string"
    )
      return null
    found.push({ file: f.file, rule: f.rule, message: f.message })
  }
  return found
}

export function checkCustomSections(
  report: Pick<CompletionReport, "checks">,
  findings: CustomFinding[] | null
): GateResult {
  const check = report.checks.find((c) => c.check === CUSTOM_CHECK)
  const gate = (passed: boolean, message: string, node: string | null) => ({
    gate: "types" as const,
    passed,
    evidence_key: check?.output_key ?? null,
    offending_node: node,
    message,
  })
  if (!check)
    return gate(
      false,
      "the build sandbox reported no custom sections check",
      null
    )
  if (check.exit_code === 0)
    return gate(
      true,
      "custom sections follow the rules, as reported by the build sandbox",
      null
    )
  const first = findings?.[0]
  if (!first)
    return gate(
      false,
      `the custom sections check exited ${check.exit_code} without a result, so the custom sections are unchecked`,
      null
    )
  return gate(
    false,
    `${first.file} breaks the ${first.rule} rule: ${first.message}${findings && findings.length > 1 ? ` (${findings.length} findings)` : ""}`,
    first.file
  )
}

/** The types gate and the custom-section check as one: the first failure is the gate's. */
export function withCustomSections(
  types: GateResult,
  custom: GateResult
): GateResult {
  if (!types.passed) return types
  if (!custom.passed) return custom
  return { ...types, message: `${types.message}; ${custom.message}` }
}
