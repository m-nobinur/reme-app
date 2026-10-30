import type { GateResult } from "@workspace/contracts"

/**
 * The interaction gate: the built site used in a browser inside the build
 * sandbox, as `apps/orchestrator/sandbox/interaction.mjs` does it (every page
 * at three widths with no console error, the menu and footer links, the
 * phone menu, the form sent to a test sink), checked from the exit code and
 * JSON it reported. A run that left no result fails closed, as `a11y` does.
 */

export type InteractionFinding = {
  check: string
  path: string
  width: number | null
  detail: string
}

export type InteractionResult = {
  pages: number
  findings: InteractionFinding[]
}

/** The most findings the failure message spells out; the evidence JSON has them all. */
const DETAILED = 8

/** The JSON is the sandbox's, so its shape is checked rather than trusted. */
export function parseInteraction(raw: unknown): InteractionResult | null {
  const r = raw as { pages?: unknown; findings?: unknown } | null
  if (typeof r?.pages !== "number" || !Array.isArray(r.findings)) return null
  return {
    pages: r.pages,
    findings: r.findings.map((f) => ({
      check: String(f?.check),
      path: String(f?.path),
      width: typeof f?.width === "number" ? f.width : null,
      detail: String(f?.detail ?? ""),
    })),
  }
}

export function checkInteraction(
  run: { exit_code: number; key: string | null } | null | undefined,
  result: InteractionResult | null
): GateResult {
  const gate = (passed: boolean, message: string, node: string | null) => ({
    gate: "interaction" as const,
    passed,
    evidence_key: run?.key ?? null,
    offending_node: node,
    message,
  })
  if (!run) return gate(false, "the pages were not tried in a browser", null)
  const first = result?.findings[0]
  if (run.exit_code === 0 && result && !first)
    return gate(
      true,
      `${result.pages} page(s) worked in a browser at 390, 768 and 1440 px`,
      null
    )
  if (!result || !first)
    return gate(
      false,
      `the browser check exited ${run.exit_code} without a result, so the pages are unchecked`,
      null
    )
  const all = result.findings
  const detail = all
    .slice(0, DETAILED)
    .map(
      (f) =>
        `- ${f.check} on ${f.path}${f.width ? ` at ${f.width} px` : ""}: ${f.detail}`
    )
    .join("\n")
  return gate(
    false,
    `using the pages in a browser found ${all.length} problem(s)\n${detail}${all.length > DETAILED ? `\n- and ${all.length - DETAILED} more in the evidence` : ""}\nRun node /tmp/interaction.mjs dist after building to see them again.`,
    `${first.path} ${first.check}`
  )
}
