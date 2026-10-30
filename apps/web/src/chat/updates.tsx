import { Link } from "@tanstack/react-router"
import {
  type Update,
  UpdateDeck,
  UpdateKindIcon,
  UpdateRow,
} from "@workspace/ui/components/assistant/update-deck"
import { buttonVariants } from "@workspace/ui/components/button"
import type { AttentionItem, Workspace } from "@/lib/api/types"
import { anchorOf } from "@/lib/reminders"
import { readyForReview } from "@/lib/site-ready"
import { useLiveWorkspace } from "@/lib/workspace"
import { SiteReadyCard } from "./site-ready"

const ACTION = buttonVariants({ variant: "outline", size: "sm" })

/** Where an item is acted on: the panel, open on it, or the reminders page. */
function actionOf(item: AttentionItem) {
  if (item.kind === "reminder") {
    return (
      <Link className={ACTION} to="/app/reminders">
        Open
      </Link>
    )
  }
  if (item.kind !== "approval" && item.kind !== "question") return undefined
  const focus = anchorOf[item.kind](item.id)
  return (
    <Link
      className={ACTION}
      state={() => ({ panel: { key: crypto.randomUUID(), focus } })}
      to="/app"
    >
      {item.kind === "question" ? "Answer" : "Review"}
    </Link>
  )
}

const metaOf = (item: AttentionItem) =>
  item.kind === "question"
    ? "Question"
    : item.kind === "approval"
      ? "Approval"
      : "Reminder"

/**
 * What waits on the owner, most pressing first: the new version of the site,
 * then questions, other approvals and reminders that came due. The site's
 * own approval is the ready card's row, so Publish works from here.
 */
export function updatesOf(workspace: Workspace | null): Update[] {
  const attention = workspace?.attention ?? []
  const site = readyForReview(workspace)
  const rest = (["question", "approval", "reminder"] as const)
    .flatMap((kind) => attention.filter((item) => item.kind === kind))
    .filter(
      (item) =>
        !(
          item.kind === "approval" &&
          item.request.approval_id === site?.approvalId
        )
    )
  return [
    ...(site ? [{ id: "site", content: <SiteReadyCard row /> }] : []),
    ...rest.map((item) => ({
      id: item.id,
      content: (
        <UpdateRow
          action={actionOf(item)}
          icon={<UpdateKindIcon kind={item.kind} />}
          meta={metaOf(item)}
          title={item.title}
        />
      ),
    })),
  ]
}

/** The new chat's deck of updates, from the polled workspace. */
export function ChatUpdates() {
  const { workspace } = useLiveWorkspace()
  return <UpdateDeck updates={updatesOf(workspace)} />
}
