import type { Workspace } from "./api/types"
import { dueLine } from "./reminders"

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
  /** The build that made it, whose preview the card opens. */
  assignmentId: string | null
  /** When it was put up for review. */
  at: string
}

/** The newest review of a built version, or null when none waits. */
export function readyForReview(
  workspace: Workspace | null
): ReadyReview | null {
  let newest: ReadyReview | null = null
  for (const item of workspace?.attention ?? []) {
    if (item.kind !== "approval" || item.request.target.kind !== "revision") {
      continue
    }
    if (newest && Date.parse(item.raisedAt) <= Date.parse(newest.at)) continue
    newest = {
      approvalId: item.request.approval_id,
      revisionId: item.request.target.revision_id,
      version: item.version,
      assignmentId: item.request.assignment_id,
      at: item.raisedAt,
    }
  }
  return newest
}

/** A version card's title: the business's website. */
export const versionTitle = (business: string | null | undefined) =>
  business ? `${business} website` : "Your website"

/** A version card's line: that it is not out yet, and when it was ready, once the reader's zone is known. */
export const versionMeta = (
  live: number | null,
  at: string,
  zone: string | null
) =>
  [
    live === null ? "Not published" : "New version, not published",
    zone ? dueLine(at, zone) : null,
  ]
    .filter(Boolean)
    .join(" · ")

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
