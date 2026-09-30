import { BellIcon } from "@phosphor-icons/react"
import { countLabel } from "@workspace/ui/components/app-shell"
import {
  type AttentionKind,
  attentionKind,
} from "@workspace/ui/components/attention-card"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { formatDateTime } from "@workspace/ui/lib/format"
import { cn, META } from "@workspace/ui/lib/utils"
import type { ComponentProps, ReactElement, ReactNode } from "react"

/**
 * The owner's notifications: questions, approvals, reports and alerts
 * (§7.3), one list separated by hairlines. Each row says what it is, when it
 * was raised, what happens if nobody acts, and links to where it is acted
 * on. The link is a slot, so this package still imports no router.
 */

type NotificationItem = {
  id: string
  kind: AttentionKind
  title: string
  /** Model or team text, bounded here rather than trusted to be short. */
  detail: string
  at: string
  expiresAt: string | null
  onExpiry: string
  action?: ReactNode
}

function NotificationList({
  items,
  error = null,
}: {
  items: NotificationItem[]
  /** Part of the list could not be read; shown above what was. */
  error?: string | null
}) {
  if (items.length === 0) {
    return error ? (
      <EmptyState
        description={error}
        icon={<BellIcon />}
        role="alert"
        title="Notifications did not load"
      />
    ) : (
      <EmptyState
        description="When your team asks you something or a version is ready to publish, it shows here. So does news about your site, like a version going live."
        icon={<BellIcon />}
        title="Nothing yet"
      />
    )
  }
  return (
    <div className="flex flex-col gap-2">
      {error ? (
        <p className={META} role="alert">
          {error}
        </p>
      ) : null}
      <ul className="flex flex-col divide-y divide-border">
        {items.map((item) => {
          const kind = attentionKind[item.kind]
          const expires = formatDateTime(item.expiresAt)
          return (
            <li
              className="flex flex-col gap-1.5 py-4"
              data-kind={item.kind}
              key={item.id}
            >
              <div className="flex items-center justify-between gap-3">
                <Badge variant={kind.variant}>
                  <kind.icon aria-hidden />
                  {kind.label}
                </Badge>
                <time className={`${META} tabular-nums`} dateTime={item.at}>
                  {formatDateTime(item.at)}
                </time>
              </div>
              <h2 className="font-medium text-base">{item.title}</h2>
              <p className="line-clamp-3 max-w-prose text-muted-foreground text-sm">
                {item.detail}
              </p>
              <p className={META}>
                {expires ? `Open until ${expires}. ` : null}
                {item.onExpiry}
              </p>
              {item.action ? <div className="pt-1">{item.action}</div> : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** One row of the bell's menu: a link to follow, or an action to run. */
type NotificationEntry = {
  id: string
  kind: AttentionKind
  title: string
  at: string
  unread: boolean
} & (
  | { link: ReactElement<ComponentProps<"a">>; onSelect?: never }
  | { onSelect: () => void; link?: never }
)

/** A count drawn on the bell's corner. */
const BADGE =
  "absolute -top-0.5 -right-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 font-medium text-[0.8125rem] text-primary-foreground tabular-nums leading-none"

const MENU_ROW = "items-start gap-3 py-2"

/**
 * The bell at the top right and the menu it opens: the newest few
 * notifications, each going where it is acted on, and a link to all of them.
 * `onOpenChange` lets the app mark them seen. The links are slots, so this
 * package still imports no router.
 */
function NotificationMenu({
  items,
  unread,
  viewAll,
  onOpenChange,
}: {
  items: NotificationEntry[]
  unread: number
  /** The link element "View all notifications" renders as. */
  viewAll: ReactElement<ComponentProps<"a">>
  onOpenChange?: (open: boolean) => void
}) {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={
              unread > 0 ? `Notifications, ${unread} unread` : "Notifications"
            }
            className="relative"
            data-slot="notification-bell"
            size="icon"
            variant="ghost"
          />
        }
      >
        <BellIcon aria-hidden />
        {unread > 0 ? (
          <span aria-hidden className={BADGE} data-slot="unread-count">
            {countLabel(unread)}
          </span>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[min(22rem,calc(100vw-1.5rem))] p-0"
      >
        <div className="flex items-center justify-between gap-3 border-border border-b px-3 py-2.5">
          <p className="font-medium text-sm">Notifications</p>
          {unread > 0 ? <p className={META}>{unread} new</p> : null}
        </div>
        <div className="max-h-[min(24rem,60svh)] overflow-y-auto p-1">
          {items.length ? (
            items.map((item) => {
              const kind = attentionKind[item.kind]
              const row = (
                <>
                  <kind.icon
                    aria-hidden
                    className={cn(
                      "mt-0.5",
                      item.kind === "alert"
                        ? "text-destructive"
                        : "text-muted-foreground"
                    )}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="line-clamp-2">
                      <span className="sr-only">{kind.label}: </span>
                      {item.title}
                    </span>
                    <time className={`${META} tabular-nums`} dateTime={item.at}>
                      {formatDateTime(item.at)}
                    </time>
                  </span>
                  {item.unread ? (
                    <span
                      className="mt-1.5 size-2 shrink-0 rounded-full bg-primary"
                      data-slot="unread-dot"
                    >
                      <span className="sr-only">, unread</span>
                    </span>
                  ) : null}
                </>
              )
              return item.link ? (
                <DropdownMenuLinkItem
                  className={MENU_ROW}
                  key={item.id}
                  render={item.link}
                >
                  {row}
                </DropdownMenuLinkItem>
              ) : (
                <DropdownMenuItem
                  className={MENU_ROW}
                  key={item.id}
                  onClick={item.onSelect}
                >
                  {row}
                </DropdownMenuItem>
              )
            })
          ) : (
            <p className="px-3 py-6 text-center text-muted-foreground text-sm">
              You are all caught up. Questions from your team and news about
              your site show here.
            </p>
          )}
        </div>
        <DropdownMenuSeparator className="mx-0 my-0" />
        <div className="p-1">
          <DropdownMenuLinkItem className="justify-center" render={viewAll}>
            View all notifications
          </DropdownMenuLinkItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export type { NotificationEntry, NotificationItem }
export { NotificationList, NotificationMenu }
