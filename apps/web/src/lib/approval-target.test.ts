import { ApprovalTargetSummary } from "@workspace/ui/components/approval-target"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"

const REVISION = "2f41c9ab-0000-4000-8000-000000000005"

/**
 * The approvals screen names a revision the way the owner does: its version,
 * with the short id beside it for matching against a preview link.
 */
it("shows a revision as its version, with the short id as secondary text", () => {
  const html = renderToStaticMarkup(
    createElement(ApprovalTargetSummary, {
      target: { kind: "revision", revision_id: REVISION },
      version: 4,
    })
  )
  expect(html).toContain("Version 4")
  expect(html).toContain("ID 2f41c9ab")
  expect(html).not.toContain(REVISION)
})

it("never labels the full revision id a version when the number is unknown", () => {
  const html = renderToStaticMarkup(
    createElement(ApprovalTargetSummary, {
      target: { kind: "revision", revision_id: REVISION },
    })
  )
  expect(html).not.toContain(REVISION)
  expect(html).not.toMatch(/Version [0-9a-f-]{9,}/)
  expect(html).toContain("ID 2f41c9ab")
})
