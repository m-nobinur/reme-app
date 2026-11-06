import { useAuiState } from "@assistant-ui/react"
import { GlobeIcon, GoogleLogoIcon } from "@phosphor-icons/react"
import { Link } from "@tanstack/react-router"
import {
  type Update,
  UpdateDeck,
  UpdateIcon,
  UpdateKindIcon,
  UpdateRow,
} from "@workspace/ui/components/assistant/update-deck"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { useRef } from "react"
import type { AttentionItem, Workspace } from "@/lib/api/types"
import { anchorOf } from "@/lib/reminders"
import { awaitsReadyLine, draftReview } from "@/lib/site-ready"
import { type JourneyItem, journeyItem, stackOrder } from "@/lib/update-stack"
import { useBack } from "@/lib/use-back"
import { useLiveWorkspace } from "@/lib/workspace"
import { useAskInChat } from "@/panel/workspace-panel"
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

/** The journey's item as a row, whose Connect says its words in the chat with its intent. */
function JourneyRow({ item }: { item: JourneyItem }) {
  const askInChat = useAskInChat()
  return (
    <UpdateRow
      action={
        <Button
          onClick={() => askInChat(item.ask, item.intent)}
          size="sm"
          variant="outline"
        >
          {item.label}
        </Button>
      }
      icon={
        <UpdateIcon icon={item.id === "google" ? GoogleLogoIcon : GlobeIcon} />
      }
      title={item.title}
    />
  )
}

const journeyUpdates = (
  workspace: Workspace | null,
  site: boolean,
  back = true
): { lead: boolean; value: Update }[] =>
  journeyItem(workspace?.journey, site, back).map((item) => ({
    lead: item.lead,
    value: { id: item.id, content: <JourneyRow item={item} /> },
  }))

/**
 * A new chat's stack, most pressing first: a name the owner went to buy,
 * the new version of the site, then questions, other approvals and
 * reminders, then the web address and Google. The site's own approval is the
 * ready card's row, so Publish works from here.
 */
export function updatesOf(workspace: Workspace | null): Update[] {
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
  return stackOrder(
    journeyUpdates(workspace, !!site),
    site ? [{ id: "site", content: <SiteReadyCard row /> }] : [],
    rest.map((item) => ({
      id: item.id,
      content: (
        <UpdateRow
          action={actionOf(item)}
          icon={<UpdateKindIcon kind={item.kind} />}
          meta={metaOf(item)}
          title={item.title}
        />
      ),
    }))
  )
}

/** The new chat's stack of updates, from the polled workspace. */
export function ChatUpdates() {
  const { workspace } = useLiveWorkspace()
  return <UpdateDeck updates={updatesOf(workspace)} />
}

/** When the newest message by `role` was written, or null. */
const lastAt = (
  messages: readonly {
    role: string
    metadata: { custom: Record<string, unknown> }
  }[],
  role: "user" | "assistant"
) => {
  const at = messages.filter((m) => m.role === role).at(-1)?.metadata
    .custom.createdAt
  return typeof at === "string" ? at : null
}

/**
 * The open conversation's ready card and its stack above the composer,
 * which knows when the owner last wrote. A new review's card waits for the
 * ready line, so the line lands above it instead of pushing it down (224 px,
 * 2026-10-25). The workspace poll re-renders it, so no timer is needed.
 */
export function ConversationUpdates() {
  // An empty chat has its own stack under the composer.
  const empty = useAuiState((s) => s.thread.messages.length === 0)
  const sentAt = useAuiState((s) => lastAt(s.thread.messages, "user"))
  const saidAt = useAuiState((s) => lastAt(s.thread.messages, "assistant"))
  const { workspace } = useLiveWorkspace()
  const review = draftReview(workspace)
  // When this tab first saw each version: a ref, read and set in render,
  // since it only ever records the first sight.
  const seen = useRef(new Map<string, number>()).current
  const now = Date.now()
  if (review && !seen.has(review.revisionId)) seen.set(review.revisionId, now)
  const waiting = awaitsReadyLine(
    review?.at ?? null,
    saidAt,
    review ? (seen.get(review.revisionId) ?? now) : now,
    now
  )
  const buyingLatest = useAuiState((s) => {
    const last = s.thread.messages.at(-1)
    return (
      last?.role === "assistant" &&
      last.content.some(
        (part) =>
          part.type === "tool-call" &&
          (part.toolName === "find_domain" || part.toolName === "buy_domain")
      )
    )
  })
  const back = useBack(
    workspace?.journey?.address.stage === "buying_elsewhere",
    sentAt
  )
  if (empty) return null
  const items = journeyUpdates(workspace, !!review, back && !buyingLatest)
  return (
    <SiteReadyCard
      className="mx-2 -mt-2"
      hidden={waiting}
      saidAt={saidAt}
      sentAt={sentAt}
      stack={(site) => stackOrder(items, site)}
    />
  )
}
