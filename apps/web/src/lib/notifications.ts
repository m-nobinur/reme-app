import type { AttentionItem } from "./api/types"

/**
 * The owner's notifications: the four §7.3 kinds, newest first. Questions
 * and approvals come from `/workspace` (the open ones), reports and alerts
 * from `/activity` (30 days). `/workspace` also carries the last day's
 * reports and alerts, so each kind is taken from one read only, or a report
 * would show twice.
 */
export function notificationsOf(
  attention: AttentionItem[],
  activity: AttentionItem[]
): AttentionItem[] {
  return [
    ...attention.filter(
      (item) => item.kind === "question" || item.kind === "approval"
    ),
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
export const SEEN_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

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
