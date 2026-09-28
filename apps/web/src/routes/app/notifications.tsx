import { createFileRoute, getRouteApi, Link } from "@tanstack/react-router"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { buttonVariants } from "@workspace/ui/components/button"
import {
  type NotificationItem,
  NotificationList,
} from "@workspace/ui/components/notification-list"
import { useEffect } from "react"
import type { AttentionItem } from "@/lib/api/types"
import {
  notificationsOf,
  SEEN_COOKIE_MAX_AGE,
  seenCookie,
  unreadCount,
} from "@/lib/notifications"
import { useLiveWorkspace } from "@/lib/workspace"

/**
 * Everything the team has raised with the owner: what waits on them now,
 * and what happened to the site in the last 30 days. It reads nothing of
 * its own: the frame's live workspace has the open questions and approvals,
 * and the frame's `/activity` read has the reports and alerts, which is
 * also what the rail counts.
 */
export const Route = createFileRoute("/app/notifications")({
  component: Notifications,
})

const frame = getRouteApi("/app")

const ACTION = buttonVariants({ variant: "outline", size: "sm" })

/** Where an item is acted on. Reports and alerts are there to read. */
function actionOf(item: AttentionItem) {
  if (item.kind === "approval") {
    return (
      <Link className={ACTION} to="/app/approvals">
        Review version {item.version}
      </Link>
    )
  }
  if (item.kind === "question") {
    // The panel lists questions first and answers them in place, so opening
    // it is enough: nothing about the question goes in the address.
    return (
      <Link className={ACTION} state={{ panel: true }} to="/app">
        Answer in the panel
      </Link>
    )
  }
  return undefined
}

const toRow = (item: AttentionItem): NotificationItem => ({
  id: item.id,
  kind: item.kind,
  title: item.title,
  detail: item.detail,
  at: item.raisedAt,
  expiresAt: item.expiresAt,
  onExpiry: item.onExpiry,
  action: actionOf(item),
})

function Notifications() {
  const { activity, seenAt, active } = frame.useLoaderData()
  const { workspace } = useLiveWorkspace()
  const items = notificationsOf(workspace?.attention ?? [], activity ?? [])
  const newest = items[0]?.raisedAt
  const unread = unreadCount(items, seenAt)
  const orgId = active?.id

  const error =
    !workspace && activity === null
      ? "Nothing could be read. Reload the page to try again."
      : !workspace
        ? "Questions and approvals did not load. Reload the page to try again."
        : activity === null
          ? "News about your site did not load. Reload the page to try again."
          : null

  // Seen means shown: the newest time on the page, on the server's clock
  // rather than this browser's, and only ever forward. Not while a read
  // failed: an item it would have shown would be marked read unseen.
  useEffect(() => {
    if (!orgId || error !== null || !newest || unread === 0) return
    // biome-ignore lint/suspicious/noDocumentCookie: the frame loader reads it on the next request, which the Cookie Store API cannot promise in every browser this app supports.
    document.cookie = `${seenCookie(orgId)}=${newest}; path=/; max-age=${SEEN_COOKIE_MAX_AGE}; samesite=lax`
  }, [orgId, error, newest, unread])

  return (
    <>
      <PageHeader
        description="Questions and approvals waiting on you, and what happened to your site in the last 30 days."
        title="Notifications"
      />
      <NotificationList error={error} items={items.map(toRow)} />
    </>
  )
}
