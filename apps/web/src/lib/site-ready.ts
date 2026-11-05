import type { AskIntent } from "@workspace/ui/lib/activity-copy"
import type { Workspace } from "./api/types"
import { dueLine } from "./reminders"
import { journeyItem } from "./update-stack"

/**
 * The chat's "your website is ready" card, from the polled workspace. It is
 * drawn in whichever conversation is open and never stored, so this reads
 * only what `/workspace` says now and what the owner did on this page.
 */

/** A version waiting for the owner's review, bound to its revision. */
export type ReadyReview = {
  /** Null while an update to it is being made: its review comes back with the update's. */
  approvalId: string | null
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

/**
 * The draft the card shows: the newest review, else the latest unpublished
 * version an update is being made to. Asking for changes pauses the draft's
 * build and takes its approval away until the update lands with a new one;
 * the update's build names that draft (`held`), so the card stays in the
 * chat meanwhile, through a reload too. It goes once the update ends or
 * that version is live.
 */
export function draftReview(workspace: Workspace | null): ReadyReview | null {
  const ready = readyForReview(workspace)
  if (ready || !workspace) return ready
  const update = workspace.builds.find(
    (build) => (build.held?.version ?? 0) > (workspace.live ?? 0)
  )
  const held = update?.held
  return update && held
    ? {
        approvalId: null,
        revisionId: held.revision_id,
        version: held.version,
        assignmentId: held.assignment_id,
        at: held.ready_at ?? update.created_at,
      }
    : null
}

/** How long a new review's card waits for the ready line, from when this tab first saw the review. */
const READY_LINE_MS = 20_000
/** A review older than this is not new: a reload shows its card at once. */
const NEW_REVIEW_MS = 120_000

/**
 * Whether the chat's card for a review raised `reviewAt` still waits for the
 * ready line: nothing the assistant said since, the review new, and not past
 * `READY_LINE_MS` since this tab first saw it (`seenAt`), after which a line
 * that could not be posted no longer holds the card. Counted from the tab's
 * own sight of it, since the poll brings a review up to its interval late.
 */
export const awaitsReadyLine = (
  reviewAt: string | null,
  saidAt: string | null,
  seenAt: number,
  now: number
) =>
  reviewAt !== null &&
  !(saidAt && Date.parse(saidAt) >= Date.parse(reviewAt)) &&
  now - Date.parse(reviewAt) < NEW_REVIEW_MS &&
  now - seenAt < READY_LINE_MS

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

/** A review the owner approved here, and when. */
export type Approved = { review: ReadyReview; at: string }

/**
 * What the card shows: the review to answer; a publishing line once the
 * owner approved it here; or nothing, when the review went some other way
 * (the panel, an expiry, a replacement). In a chat (`saidAt` given) the line
 * works until the assistant says something after the approval, its live
 * message, with `published` once that version is live, since the load check
 * runs a while after; then it goes, since the live message says it.
 * Elsewhere it goes once the version is live.
 */
type ReadyCard =
  | { kind: "review"; review: ReadyReview }
  | { kind: "approved"; version: number; published: boolean }
  | null

export function readyCard(
  ready: ReadyReview | null,
  approvedHere: Approved | null,
  live: number | null,
  saidAt?: string | null
): ReadyCard {
  if (ready && ready.approvalId !== approvedHere?.review.approvalId) {
    return { kind: "review", review: ready }
  }
  if (!approvedHere) return null
  const { version } = approvedHere.review
  const published = (live ?? 0) >= version
  const gone =
    saidAt === undefined
      ? published
      : saidAt !== null && Date.parse(saidAt) > Date.parse(approvedHere.at)
  return gone ? null : { kind: "approved", version, published }
}

/**
 * The ready card's one extra step beside Publish, off the chat (the chat's
 * update stack carries it there): the journey's own item, so the Website
 * page offers what the stack does, and nothing while the api has not said.
 */
export function readySlot(
  workspace: Workspace | null
): { label: string; ask: string; intent: AskIntent } | null {
  const item = journeyItem(workspace?.journey, true)
  return item && { label: item.label, ask: item.ask, intent: item.intent }
}
