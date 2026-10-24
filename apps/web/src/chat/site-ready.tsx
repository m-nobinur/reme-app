import { useAuiState } from "@assistant-ui/react"
import { getRouteApi } from "@tanstack/react-router"
import { revisionPictures } from "@workspace/contracts"
import { SiteReady } from "@workspace/ui/components/assistant/site-ready"
import { useState } from "react"
import { decideApproval } from "@/lib/api/server"
import { DECISION_REFUSED } from "@/lib/decision"
import {
  type ReadyReview,
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
 * composer.
 */
export function SiteReadyCard({
  className,
  sentAt = null,
}: {
  className?: string
  sentAt?: string | null
}) {
  const live = useLiveWorkspace()
  const { active } = frame.useLoaderData()
  const zone = useBrowserZone()
  const requestChanges = useRequestChanges()
  const [approved, setApproved] = useState<ReadyReview | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const card = readyCard(
    readyForReview(live.workspace),
    approved,
    live.workspace?.live ?? null
  )
  const review = card?.kind === "review" ? card.review : null
  const [preview, retryPreview] = usePreview(review?.assignmentId ?? null)
  if (!card) return null
  const title = versionTitle(active?.name)
  const at = review?.at ?? approved?.at
  const docked = !!sentAt && !!at && Date.parse(sentAt) > Date.parse(at)
  if (!review) {
    return (
      <SiteReady
        approved
        className={className}
        docked={docked}
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
        setApproved(review)
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
      error={error}
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

/** The ready card in the open conversation, which knows when the owner last wrote. */
export function ChatSiteReadyCard() {
  const sentAt = useAuiState((s) => {
    const at = s.thread.messages
      .filter((message) => message.role === "user")
      .at(-1)?.metadata.custom.createdAt
    return typeof at === "string" ? at : null
  })
  return <SiteReadyCard className="mx-2" sentAt={sentAt} />
}
