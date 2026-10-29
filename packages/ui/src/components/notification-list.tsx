import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { BellIcon, HourglassMediumIcon } from "@phosphor-icons/react"
import { railItemClass } from "@workspace/ui/components/app-shell"
import {
  type AttentionKind,
  attentionKind,
} from "@workspace/ui/components/attention-card"
import { Badge } from "@workspace/ui/components/badge"
import { EmptyState } from "@workspace/ui/components/empty-state"
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs"
import { Hint } from "@workspace/ui/components/tooltip"
import { formatDateTime } from "@workspace/ui/lib/format"
import { cn, META } from "@workspace/ui/lib/utils"
import {
  type ComponentProps,
  cloneElement,
  type ReactElement,
  type ReactNode,
  useState,
} from "react"

/**
 * The owner's notifications: questions, approvals, reports and alerts
 * (§7.3), one list separated by hairlines. Each row says what it is, when it
 * was raised, what happens if nobody acts, and links to where it is acted
 * on. The link is a slot, so this package still imports no router.
 */

/**
 * A job waiting on the owner (a DNS change, a payment, a sign-in), listed
 * beside the notifications from the same list the panel reads. Not a sixth
 * attention kind: it is where work stands, not something raised.
 */
type EntryKind = AttentionKind | "wait"
const WAIT = {
  label: "Waiting on you",
  icon: HourglassMediumIcon,
  variant: "secondary",
} as const
const kindOf = (kind: EntryKind) =>
  kind === "wait" ? WAIT : attentionKind[kind]

type NotificationItem = {
  id: string
  kind: EntryKind
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
  zone,
}: {
  items: NotificationItem[]
  /** Part of the list could not be read; shown above what was. */
  error?: string | null
  /** The reader's time zone once it is known, UTC before, as the panel does. */
  zone?: string | null
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
          const kind = kindOf(item.kind)
          const expires = formatDateTime(item.expiresAt, zone ?? undefined)
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
                  {formatDateTime(item.at, zone ?? undefined)}
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
  kind: EntryKind
  title: string
  at: string
  unread: boolean
} & (
  | { link: ReactElement<ComponentProps<"a">>; onSelect?: never }
  | { onSelect: () => void; link?: never }
)

/** The tabs: what waits on the owner, and what has happened. */
const TABS = [
  { id: "all", label: "All", kinds: null },
  {
    id: "needs-you",
    label: "Needs you",
    kinds: ["wait", "question", "approval", "reminder"],
  },
  { id: "updates", label: "Updates", kinds: ["report", "alert"] },
] as const

const ROW =
  "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-start text-sm outline-none transition-colors duration-150 hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring motion-reduce:transition-none"

/**
 * The bell in the rail and the popover it opens beside it: the newest few
 * notifications under All, Needs you and Updates, each going where it is
 * acted on, and a link to all of them. `onOpenChange` lets the app mark them
 * seen. The links are slots, so this package still imports no router.
 */
function NotificationMenu({
  items,
  unread,
  viewAll,
  onOpenChange,
  zone,
}: {
  items: NotificationEntry[]
  unread: number
  /** The link element "View all notifications" renders as. */
  viewAll: ReactElement<ComponentProps<"a">>
  onOpenChange?: (open: boolean) => void
  /** The reader's time zone once it is known, UTC before. */
  zone?: string | null
}) {
  const [open, setOpen] = useState(false)
  const change = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }

  return (
    <PopoverPrimitive.Root onOpenChange={change} open={open}>
      <Hint label="Notifications" side="right">
        <PopoverPrimitive.Trigger
          aria-label={
            unread > 0 ? `Notifications, ${unread} unread` : "Notifications"
          }
          className={railItemClass}
          data-slot="notification-bell"
        >
          <BellIcon aria-hidden />
          {unread > 0 ? (
            <span
              aria-hidden
              className="absolute start-6 top-2 size-2 rounded-full bg-destructive ring-2 ring-rail"
              data-slot="unread-dot"
            />
          ) : null}
          <span data-slot="rail-label">Notifications</span>
        </PopoverPrimitive.Trigger>
      </Hint>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          align="end"
          className="isolate z-50 outline-none"
          side="right"
          sideOffset={12}
        >
          <PopoverPrimitive.Popup
            className="flex max-h-[min(32rem,var(--available-height))] w-[min(23rem,calc(100vw-1.5rem))] origin-(--transform-origin) flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-lg outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-starting-style:scale-95 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none"
            data-slot="notification-menu-content"
          >
            <PopoverPrimitive.Title className="px-5 pt-4 font-semibold text-lg">
              Notifications
            </PopoverPrimitive.Title>
            <Tabs className="min-h-0 flex-1 gap-0 pt-3" defaultValue="all">
              <TabsList className="gap-1 border-0 px-4">
                {TABS.map((tab) => (
                  <TabsTrigger
                    className="mb-0 rounded-full border-0 px-3 data-active:bg-muted"
                    key={tab.id}
                    value={tab.id}
                  >
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              {TABS.map((tab) => {
                const shown = tab.kinds
                  ? items.filter((item) =>
                      (tab.kinds as readonly string[]).includes(item.kind)
                    )
                  : items
                return (
                  <TabsContent
                    className="min-h-0 flex-1 gap-0 overflow-y-auto overscroll-contain rounded-none p-2 pt-3"
                    key={tab.id}
                    value={tab.id}
                  >
                    {shown.length ? (
                      <ul className="flex flex-col">
                        {shown.map((item) => (
                          <li key={item.id}>
                            <EntryRow
                              close={() => change(false)}
                              item={item}
                              zone={zone}
                            />
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="px-3 py-8 text-center text-muted-foreground text-sm">
                        {tab.id === "needs-you"
                          ? "Nothing is waiting on you."
                          : tab.id === "updates"
                            ? "No news about your site yet."
                            : "You are all caught up. Questions from your team and news about your site show here."}
                      </p>
                    )}
                  </TabsContent>
                )
              })}
            </Tabs>
            <div className="border-border border-t p-2">
              {cloneElement(viewAll, {
                className: `${ROW} items-center justify-center py-2 font-medium`,
                onClick: () => change(false),
                children: "View all notifications",
              })}
            </div>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

function EntryRow({
  item,
  close,
  zone,
}: {
  item: NotificationEntry
  close: () => void
  zone?: string | null | undefined
}) {
  const kind = kindOf(item.kind)
  const row = (
    <>
      <kind.icon
        aria-hidden
        className={cn(
          "mt-0.5 size-5 shrink-0",
          item.kind === "alert" ? "text-destructive" : "text-muted-foreground"
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="line-clamp-2 font-medium">{item.title}</span>
        <span className={META}>
          {kind.label} ·{" "}
          <time className="tabular-nums" dateTime={item.at}>
            {formatDateTime(item.at, zone ?? undefined)}
          </time>
        </span>
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
    cloneElement(item.link, { className: ROW, onClick: close, children: row })
  ) : (
    <button
      className={ROW}
      onClick={() => {
        item.onSelect?.()
        close()
      }}
      type="button"
    >
      {row}
    </button>
  )
}

export type { NotificationEntry, NotificationItem }
export { NotificationList, NotificationMenu }
