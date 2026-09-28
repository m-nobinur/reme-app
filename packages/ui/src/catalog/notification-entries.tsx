import { BellIcon } from "@phosphor-icons/react"
import { AttentionItem } from "@workspace/contracts"
import {
  AppNav,
  NavCount,
  navLinkClass,
} from "@workspace/ui/components/app-shell"
import { buttonVariants } from "@workspace/ui/components/button"
import {
  type NotificationItem,
  NotificationList,
} from "@workspace/ui/components/notification-list"
import type { ReactNode } from "react"

/**
 * Catalog entries for the notifications page and the rail's unread count.
 * The kinds, the report variants and the alert reasons are enumerated from
 * `AttentionItem` in the contract, so a kind or a reason added there fails
 * the build here until it has words. The words are the ones
 * `apps/web/src/lib/api/client.ts` writes. Brightclean is invented.
 */

type Entry = { name: string; render: () => ReactNode }

type Kind = AttentionItem["kind"]
type Report = Extract<AttentionItem, { kind: "report" }>
type Alert = Extract<AttentionItem, { kind: "alert" }>

/** Every report `what` and every alert `reason` the contract allows. */
const WHATS = AttentionItem.options.flatMap((option) => {
  const shape = option.shape
  return "what" in shape ? shape.what.options : []
})
const REASONS = AttentionItem.options.flatMap((option) => {
  const shape = option.shape
  return "reason" in shape ? shape.reason.options : []
})

const AT = "2026-10-02T09:00:00.000Z"
const hoursBefore = (hours: number) =>
  new Date(Date.parse(AT) - hours * 3_600_000).toISOString()

const ACTION = buttonVariants({ variant: "outline", size: "sm" })

const REPORTS: Record<Report["what"], { title: string; detail: string }> = {
  published: {
    title: "Published v3",
    detail: "Version 3 is live on your site.",
  },
}

const ALERTS: Record<Alert["reason"], { title: string; detail: string }> = {
  build_failed: {
    title: "A build failed",
    detail: "It stopped before it had a version to show you.",
  },
  budget_parked: {
    title: "A build paused at its spending limit",
    detail: "It spends nothing more until it is picked up again.",
  },
  publish_rolled_back: {
    title: "A publish was rolled back",
    detail:
      "The new version failed its checks once live, so your site went back to the one before.",
  },
}

const reportRows = (): NotificationItem[] =>
  WHATS.map((what, index) => ({
    id: `report-${what}`,
    kind: "report",
    ...REPORTS[what],
    at: hoursBefore(10 + index),
    expiresAt: null,
    onExpiry: "Nothing to decide.",
  }))

const alertRows = (): NotificationItem[] =>
  REASONS.map((reason, index) => ({
    id: `alert-${reason}`,
    kind: "alert",
    ...ALERTS[reason],
    at: hoursBefore(20 + index),
    expiresAt: null,
    onExpiry: "Nothing to decide.",
  }))

/** One row of each kind the contract has, in its order. */
const ONE_OF_EACH: Record<Kind, NotificationItem> = {
  question: {
    id: "question",
    kind: "question",
    title: "Weekday hours",
    detail: "The contact section shows when you are open.",
    at: hoursBefore(1),
    expiresAt: "2026-10-04T09:00:00.000Z",
    onExpiry: "The build waits on you until you answer.",
    action: (
      <a className={ACTION} href="#answer">
        Answer in the panel
      </a>
    ),
  },
  approval: {
    id: "approval",
    kind: "approval",
    title: "Version 4 is ready to publish",
    detail: "The hero now leads with end of tenancy cleans.",
    at: hoursBefore(2),
    expiresAt: "2026-10-04T09:00:00.000Z",
    onExpiry:
      "Nothing is published without you. If it expires, the build waits until you decide.",
    action: (
      <a className={ACTION} href="#approvals">
        Review version 4
      </a>
    ),
  },
  report: reportRows()[0] as NotificationItem,
  alert: alertRows()[0] as NotificationItem,
}

/** The rail's notifications link with `count` unread. */
const rail = (count: number) => (
  <div className="max-w-60 rounded-lg bg-rail p-3 text-rail-foreground">
    <AppNav aria-label={`Main, ${count} unread`}>
      <li>
        <a className={navLinkClass} href="#notifications">
          <BellIcon aria-hidden />
          Notifications
          <NavCount count={count} />
        </a>
      </li>
    </AppNav>
  </div>
)

const notificationCatalog: Entry[] = [
  {
    name: "NotificationList",
    render: () => (
      <NotificationList
        items={AttentionItem.options.map(
          (option) => ONE_OF_EACH[option.shape.kind.value]
        )}
      />
    ),
  },
  {
    name: "NotificationList reports and alerts",
    render: () => (
      <NotificationList items={[...reportRows(), ...alertRows()]} />
    ),
  },
  {
    name: "NotificationList empty",
    render: () => <NotificationList items={[]} />,
  },
  {
    name: "NotificationList error",
    render: () => (
      <NotificationList
        error="News about your site did not load. Reload the page to try again."
        items={[ONE_OF_EACH.question, ONE_OF_EACH.approval]}
      />
    ),
  },
  {
    name: "NotificationList failed",
    render: () => (
      <NotificationList
        error="Nothing could be read. Reload the page to try again."
        items={[]}
      />
    ),
  },
  { name: "NavCount", render: () => rail(3) },
  { name: "NavCount none", render: () => rail(0) },
  { name: "NavCount capped", render: () => rail(120) },
]

export { notificationCatalog }
