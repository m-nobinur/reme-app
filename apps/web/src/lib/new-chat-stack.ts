import type { Workspace } from "./api/types"
import { draftReview } from "./site-ready"
import { journeyItem } from "./update-stack"

/**
 * What a new chat's stack holds, before it is drawn: the new version of the
 * site, then questions, other approvals and reminders. The site's own
 * approval is the ready card's row, so it is not listed again.
 */
export function newChatAttention(workspace: Workspace | null) {
  const attention = workspace?.attention ?? []
  const site = draftReview(workspace)
  const rest = (["question", "approval", "reminder"] as const)
    .flatMap((kind) => attention.filter((item) => item.kind === kind))
    .filter(
      (item) =>
        !(
          item.kind === "approval" &&
          item.request.approval_id === site?.approvalId
        )
    )
  return { site, rest }
}

/** How many updates a new chat's stack shows, the journey's rows with them. */
export function newChatCount(workspace: Workspace | null) {
  const { site, rest } = newChatAttention(workspace)
  return (
    journeyItem(workspace?.journey, !!site).length +
    (site ? 1 : 0) +
    rest.length
  )
}
