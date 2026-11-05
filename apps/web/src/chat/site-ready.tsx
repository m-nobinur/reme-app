import { getRouteApi } from "@tanstack/react-router"
import { revisionPictures } from "@workspace/contracts"
import { SiteReady } from "@workspace/ui/components/assistant/site-ready"
import {
  DockedUpdates,
  type Update,
} from "@workspace/ui/components/assistant/update-deck"
import { type ReactNode, useState } from "react"
import { decideApproval } from "@/lib/api/server"
import { DECISION_REFUSED } from "@/lib/decision"
import {
  type Approved,
  draftReview,
  readyCard,
  readySlot,
  versionMeta,
  versionTitle,
} from "@/lib/site-ready"
import { useLiveWorkspace } from "@/lib/workspace"
import {
  useAskInChat,
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
 * chat and on the Website page. `row` draws only its first row, for the new
 * chat's updates.
 *
 * In a conversation (`stack` given) it also draws the update stack above
 * the composer, with the journey's items around it. `sentAt` is when the
 * owner last wrote there; once that is after the review went up, the card
 * docks into the stack. `hidden` keeps a new review's card back while its
 * ready line is on its way.
 */
export function SiteReadyCard({
  className,
  sentAt = null,
  saidAt,
  row = false,
  stack,
  hidden = false,
}: {
  className?: string
  sentAt?: string | null
  /** In a chat, when the assistant last wrote: its live message ends the publishing line. */
  saidAt?: string | null | undefined
  row?: boolean
  /** The stack's items around the docked card, given it (empty when it is not docked). */
  stack?: (site: Update[]) => Update[]
  hidden?: boolean
}) {
  const live = useLiveWorkspace()
  const { active } = frame.useLoaderData()
  const zone = useBrowserZone()
  const requestChanges = useRequestChanges()
  const askInChat = useAskInChat()
  // Off the chat only: there the stack carries the step.
  const slot = stack ? null : readySlot(live.workspace)
  const connect = slot && {
    label: slot.label,
    onClick: () => askInChat(slot.ask, slot.intent),
  }
  const [approved, setApproved] = useState<Approved | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [spot, setSpot] = useState<HTMLElement | null>(null)
  const draft = draftReview(live.workspace)
  const card = hidden
    ? null
    : readyCard(draft, approved, live.workspace?.live ?? null, saidAt)
  const review = card?.kind === "review" ? card.review : null
  const [preview, retryPreview] = usePreview(review?.assignmentId ?? null)
  const title = versionTitle(active?.name)
  const at = review?.at ?? approved?.review.at
  const docked = !!sentAt && !!at && Date.parse(sentAt) > Date.parse(at)
  const updates = stack?.(
    card && docked
      ? [
          {
            id: "site",
            content: <div className="flex min-w-0 flex-1" ref={setSpot} />,
          },
        ]
      : []
  )
  const placed = stack ? { spot, docked } : { docked }
  const drawn = (site: ReactNode) =>
    updates ? (
      <>
        {site}
        <DockedUpdates updates={updates} />
      </>
    ) : (
      site
    )
  if (!card) return drawn(null)
  if (!review) {
    return drawn(
      <SiteReady
        approved
        published={card.kind === "approved" && card.published}
        className={className}
        {...placed}
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

  const { approvalId } = review
  const approve = async () => {
    if (!approvalId) return
    setPending(true)
    setError(null)
    try {
      const outcome = await decideApproval({
        data: {
          approvalId,
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

  return drawn(
    <SiteReady
      className={className}
      {...placed}
      row={row}
      connect={connect}
      error={error}
      // Each message the owner sends closes an opened card, so the chat shows.
      closeOn={sentAt}
      held={!approvalId}
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
