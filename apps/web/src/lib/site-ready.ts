import type { Workspace } from "./api/types"

/**
 * The chat's "your website is ready" card, from the polled workspace. It is
 * drawn in whichever conversation is open and never stored, so this reads
 * only what `/workspace` says now and what the owner did on this page.
 */

/** A version waiting for the owner's review, bound to its revision. */
export type ReadyReview = {
  approvalId: string
  revisionId: string
  version: number
  /** Generated pictures, for the card to badge. */
  photos?: { slot_id: string; section: string; alt: string }[]
}

/** The newest review of a built version, or null when none waits. */
export function readyForReview(
  workspace: Workspace | null
): ReadyReview | null {
  let newest: (ReadyReview & { at: string }) | null = null
  for (const item of workspace?.attention ?? []) {
    if (item.kind !== "approval" || item.request.target.kind !== "revision") {
      continue
    }
    if (newest && Date.parse(item.raisedAt) <= Date.parse(newest.at)) continue
    newest = {
      approvalId: item.request.approval_id,
      revisionId: item.request.target.revision_id,
      version: item.version,
      ...(item.photos ? { photos: item.photos } : {}),
      at: item.raisedAt,
    }
  }
  if (!newest) return null
  const { at: _, ...review } = newest
  return review
}

/**
 * What the card shows: the review to answer; a quiet line once the owner
 * approved it here, until that version is live or a newer one asks again; or
 * nothing, when the review went some other way (the panel, an expiry, a
 * replacement).
 */
type ReadyCard =
  | { kind: "review"; review: ReadyReview }
  | { kind: "approved"; version: number }
  | null

export function readyCard(
  ready: ReadyReview | null,
  approvedHere: ReadyReview | null,
  live: number | null
): ReadyCard {
  if (ready && ready.approvalId !== approvedHere?.approvalId) {
    return { kind: "review", review: ready }
  }
  return approvedHere && (live ?? 0) < approvedHere.version
    ? { kind: "approved", version: approvedHere.version }
    : null
}
