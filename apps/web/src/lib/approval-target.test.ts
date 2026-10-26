import { ApprovalTargetSummary } from "@workspace/ui/components/approval-target"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"

const REVISION = "2f41c9ab-0000-4000-8000-000000000005"

/**
 * The approvals screen names a revision the way the owner does: a new version
 * of the website, with no number or id to read. Support matches a report to
 * the revision through an attribute.
 */
it("shows a revision in the owner's words and keeps its id off the page", () => {
  const html = renderToStaticMarkup(
    createElement(ApprovalTargetSummary, {
      target: { kind: "revision", revision_id: REVISION },
    })
  )
  expect(html).toContain("A new version of your website")
  expect(html).toContain(`data-revision="${REVISION}"`)
  expect(html.replace(/ data-revision="[^"]*"/, "")).not.toMatch(
    /2f41c9ab|ID |Version \d/
  )
})
