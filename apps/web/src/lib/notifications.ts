import { type OwnerWait, ownerWaits } from "@workspace/ui/lib/activity-copy"
import type { AttentionItem, Workspace } from "./api/types"

/**
 * The jobs waiting on the owner that no notification already stands for: a
 * DNS change, a payment, a sign-in, a setup question. From `ownerWaits`, the
 * list the panel's Waiting on you reads, so the bell never says nothing waits
 * while the panel lists something. A version to publish and a build's
 * question are notifications of their own, so they are left out here.
 */
export const jobWaits = (workspace: Workspace | null): OwnerWait[] =>
  ownerWaits(workspace?.activity).filter(
    (wait) =>
      wait.kind !== "golive" &&
      wait.kind !== "review" &&
      wait.kind !== "question"
  )

/** Where a waiting job is done: setup in the chat, the rest on the Website page. */
export const waitPage = (wait: OwnerWait) =>
  wait.kind === "onboarding" ? "/app" : "/app/website"

/**
 * The owner's notifications: the five §7.3 kinds, newest first. Questions,
 * approvals and reminders that came due come from `/workspace` (the open
 * ones), reports and alerts from `/activity` (30 days). `/workspace` also
 * carries the last day's reports and alerts, so each kind is taken from one
 * read only, or a report would show twice: `attention` is the frame's, which
 * `waitingOnOwner` has already cut to questions, approvals and reminders.
 */
export function notificationsOf(
  attention: AttentionItem[],
  activity: AttentionItem[]
): AttentionItem[] {
  return [
    ...attention,
    ...activity.filter(
      (item) => item.kind === "report" || item.kind === "alert"
    ),
  ].sort((a, b) => Date.parse(b.raisedAt) - Date.parse(a.raisedAt))
}

/**
 * The cookie holding the newest time the owner has seen on the
 * notifications page, one per organisation, so seeing one never marks
 * another's read. Per browser: another device counts its own.
 */
export const seenCookie = (orgId: string) => `reme-notifications-seen-${orgId}`
const SEEN_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

/** Records `at` as the newest time the owner has seen, for the next frame read. */
export function markSeen(orgId: string, at: string) {
  // biome-ignore lint/suspicious/noDocumentCookie: the frame loader reads it on the next request, which the Cookie Store API cannot promise in every browser this app supports.
  document.cookie = `${seenCookie(orgId)}=${at}; path=/; max-age=${SEEN_COOKIE_MAX_AGE}; samesite=lax`
}

/** The later of two seen times; either can be missing. */
export const laterSeen = (a: string | null, b: string | null) =>
  a === null || (b !== null && Date.parse(b) > Date.parse(a)) ? b : a

/** The cookie's time, or null when it is missing or not a time. */
export const seenAtOf = (value: string | undefined): string | null =>
  value && !Number.isNaN(Date.parse(value)) ? value : null

/**
 * What the owner has not seen: items raised after `seenAt`. An item at
 * exactly that time is the one the page last showed, so it is read. With
 * no cookie, everything is unread.
 */
export function unreadCount(
  items: AttentionItem[],
  seenAt: string | null
): number {
  if (seenAt === null) return items.length
  const seen = Date.parse(seenAt)
  return items.filter((item) => Date.parse(item.raisedAt) > seen).length
}
