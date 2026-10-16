import { useNavigate } from "@tanstack/react-router"
import { SiteReady } from "@workspace/ui/components/assistant/site-ready"
import { useState } from "react"
import { decideApproval } from "@/lib/api/server"
import type { WriteOutcome } from "@/lib/api/types"
import { DECISION_REFUSED } from "@/lib/decision"
import { anchorOf } from "@/lib/reminders"
import { type ReadyReview, readyCard, readyForReview } from "@/lib/site-ready"
import { useLiveWorkspace } from "@/lib/workspace"
import { photoActions } from "@/panel/photo-actions"
import { useRequestChanges } from "@/panel/workspace-panel"

const FAILED = "That did not go through. Try again."

/**
 * The ready card, wired: the review comes from the polled workspace, Approve
 * is the panel's own decision bound to the revision, and Make changes is the
 * panel's Request changes, which puts the composer in website change mode.
 */
export function SiteReadyCard() {
  const live = useLiveWorkspace()
  const navigate = useNavigate()
  const requestChanges = useRequestChanges()
  const [approved, setApproved] = useState<ReadyReview | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const card = readyCard(
    readyForReview(live.workspace),
    approved,
    live.workspace?.live ?? null
  )
  if (!card) return null
  if (card.kind === "approved") {
    return (
      <SiteReady
        approved
        onApprove={() => undefined}
        onMakeChanges={requestChanges}
        onSeePreview={() => undefined}
        version={card.version}
      />
    )
  }
  const { review } = card

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

  // A photo change is a new version: the card waits for the workspace to say so.
  const change = (write: () => Promise<WriteOutcome>) => {
    setPending(true)
    setError(null)
    write()
      .then(async (outcome) => {
        if (outcome.done) await live.refresh()
        else setError(outcome.reason)
      })
      .catch(() => setError(FAILED))
      .finally(() => setPending(false))
  }

  return (
    <SiteReady
      error={error}
      onApprove={() => void approve()}
      onMakeChanges={requestChanges}
      onSeePreview={() =>
        void navigate({
          to: ".",
          state: {
            panel: {
              key: crypto.randomUUID(),
              focus: anchorOf.approval(review.approvalId),
            },
          },
        })
      }
      pending={pending}
      photoActions={review.photos?.length ? photoActions(change) : undefined}
      photos={review.photos ?? []}
      version={review.version}
    />
  )
}
