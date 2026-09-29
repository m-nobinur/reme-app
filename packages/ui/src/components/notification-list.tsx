import { BellIcon } from "@phosphor-icons/react"
import {
  type AttentionKind,
  attentionKind,
} from "@workspace/ui/components/attention-card"
import { Badge } from "@workspace/ui/components/badge"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { formatDateTime } from "@workspace/ui/lib/format"
import { META } from "@workspace/ui/lib/utils"
import type { ReactNode } from "react"

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

export type { NotificationItem }
export { NotificationList }
