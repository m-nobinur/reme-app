import { useAuiState } from "@assistant-ui/react"
import { getRouteApi } from "@tanstack/react-router"
import { revisionPictures } from "@workspace/contracts"
import { SiteReady } from "@workspace/ui/components/assistant/site-ready"
import { useRef, useState } from "react"
import { decideApproval } from "@/lib/api/server"
import { DECISION_REFUSED } from "@/lib/decision"
import {
  type Approved,
  awaitsReadyLine,
  readyCard,
  readyForReview,
  versionMeta,
  versionTitle,
} from "@/lib/site-ready"
import { useLiveWorkspace } from "@/lib/workspace"
import {
  useBrowserZone,
  usePreview,
  useRequestChanges,
} from "@/panel/workspace-panel"

const FAILED = "That did not go through. Try again."

const frame = getRouteApi("/app")

/**
 * The ready card, wired: the review comes from the polled workspace, Publish
 * is the panel's own decision bound to the revision, and Request changes is
 * the panel's, which puts the composer in website change mode. Drawn in the
 * chat and on the Website page. `sentAt` is when the owner last wrote in the
 * chat; once that is after the review went up, the card docks above the
 * composer. `row` draws only its first row, for the new chat's updates.
 */
export function SiteReadyCard({
  className,
  sentAt = null,
  saidAt,
  row = false,
}: {
  className?: string
  sentAt?: string | null
  /** In a chat, when the assistant last wrote: its live message ends the publishing line. */
  saidAt?: string | null | undefined
  row?: boolean
}) {
  const live = useLiveWorkspace()
  const { active } = frame.useLoaderData()
  const zone = useBrowserZone()
  const requestChanges = useRequestChanges()
  const [approved, setApproved] = useState<Approved | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const card = readyCard(
    readyForReview(live.workspace),
    approved,
    live.workspace?.live ?? null,
    saidAt
  )
  const review = card?.kind === "review" ? card.review : null
  const [preview, retryPreview] = usePreview(review?.assignmentId ?? null)
  if (!card) return null
  const title = versionTitle(active?.name)
  const at = review?.at ?? approved?.review.at
  const docked = !!sentAt && !!at && Date.parse(sentAt) > Date.parse(at)
  if (!review) {
    return (
      <SiteReady
        approved
        live={card.kind === "approved" && card.live}
        published={card.kind === "approved" && card.published}
        className={className}
        docked={docked}
        row={row}
        meta=""
        onApprove={() => undefined}
        onMakeChanges={requestChanges}
        pictures={null}
        preview="loading"
        title={title}
      />
    )
  }

  const approve = async () => {
    setPending(true)
    setError(null)
    try {
      const outcome = await decideApproval({
        data: {
          approvalId: review.approvalId,
          revisionId: review.revisionId,
          decision: "approved",
        },
      })
      if (outcome.recorded) {
        setApproved({ review, at: new Date().toISOString() })
        await live.refresh()
      } else {
        setError(DECISION_REFUSED[outcome.reason])
      }
    } catch {
      setError(FAILED)
    } finally {
      setPending(false)
    }
  }

  return (
    <SiteReady
      className={className}
      docked={docked}
      row={row}
      error={error}
      // Each message the owner sends closes an opened card, so the chat shows.
      closeOn={sentAt}
      meta={versionMeta(live.workspace?.live ?? null, review.at, zone)}
      onApprove={() => void approve()}
      onMakeChanges={requestChanges}
      onRetryPreview={retryPreview}
      pending={pending}
      pictures={revisionPictures(review.revisionId)}
      preview={preview}
      title={title}
    />
  )
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
 * The ready card in the open conversation, which knows when the owner last
 * wrote. A new review's card waits for the ready line, so the line lands
 * above it instead of pushing it down (224 px, 2026-10-25). The workspace
 * poll re-renders it, so no timer is needed.
 */
export function ChatSiteReadyCard() {
  // An empty chat has it in its updates instead.
  const empty = useAuiState((s) => s.thread.messages.length === 0)
  const sentAt = useAuiState((s) => lastAt(s.thread.messages, "user"))
  const saidAt = useAuiState((s) => lastAt(s.thread.messages, "assistant"))
  const review = readyForReview(useLiveWorkspace().workspace)
  // When this tab first saw each review: a ref, read and set in render, since
  // it only ever records the first sight.
  const seen = useRef(new Map<string, number>()).current
  const now = Date.now()
  if (review && !seen.has(review.approvalId)) seen.set(review.approvalId, now)
  const waiting = awaitsReadyLine(
    review?.at ?? null,
    saidAt,
    review ? (seen.get(review.approvalId) ?? now) : now,
    now
  )
  return empty || waiting ? null : (
    <SiteReadyCard className="mx-2" saidAt={saidAt} sentAt={sentAt} />
  )
}
