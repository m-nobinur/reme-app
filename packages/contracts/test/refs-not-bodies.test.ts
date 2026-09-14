import { describe, expect, it } from "vitest"
import { buildOpenApi } from "../scripts/openapi.ts"
import { CompletionReport, ValidationReport } from "../src/report.ts"
import { samples } from "./samples.ts"

/**
 * R8, for the shapes that cross the Workflow: refs, never bodies, and no
 * money. Screenshots, evidence, source and artifacts are R2 keys; cost is
 * computed from the event log (§29.2), never carried on a report where it
 * could disagree with the log. The check reads the emitted JSON Schema, so a
 * field added to any of these six shapes has to pass it too.
 */
const TRACKED = [
  "CompletionReport",
  "DeploymentManifest",
  "InformationAnswer",
  "ProgressEvent",
  "SiteRevision",
  "ValidationReport",
] as const

const BODY_OR_MONEY = /(usd|cost|price|tokens|content|body|bytes|base64|html)$/

function propertyNames(schema: unknown, prefix = ""): string[] {
  if (typeof schema !== "object" || schema === null) {
    return []
  }
  const node = schema as {
    properties?: Record<string, unknown>
    items?: unknown
    additionalProperties?: unknown
  }
  const own = Object.entries(node.properties ?? {}).flatMap(([name, child]) => [
    `${prefix}${name}`,
    ...propertyNames(child, `${prefix}${name}.`),
  ])
  return [
    ...own,
    ...propertyNames(node.items, `${prefix}[].`),
    ...propertyNames(node.additionalProperties, `${prefix}*.`),
  ]
}

describe("refs cross the Workflow, never bodies", () => {
  const { components } = buildOpenApi() as {
    components: { schemas: Record<string, unknown> }
  }

  it.each(TRACKED)("%s names no body or money field", (name) => {
    const offending = propertyNames(components.schemas[name]).filter((path) =>
      BODY_OR_MONEY.test(path)
    )
    expect(offending).toStrictEqual([])
  })

  it("a completion report with nothing checked is refused", () => {
    const sample = samples.CompletionReport as Record<string, unknown>
    expect(CompletionReport.safeParse({ ...sample, checks: [] }).success).toBe(
      false
    )
  })

  it("a change path cannot leave the site", () => {
    const sample = samples.CompletionReport as { changes: unknown[] }
    for (const path of ["/etc/passwd", "../secrets", "src/../../x", ".."]) {
      const candidate = {
        ...sample,
        changes: [{ path, reason: "planted" }],
      }
      expect(
        CompletionReport.safeParse(candidate).success,
        `accepted ${path}`
      ).toBe(false)
    }
  })

  it("a gate the runner does not know is refused", () => {
    const sample = samples.ValidationReport as { gates: object[] }
    const candidate = {
      ...sample,
      gates: [{ ...sample.gates[0], gate: "lighthouse" }],
    }
    expect(ValidationReport.safeParse(candidate).success).toBe(false)
  })
})
