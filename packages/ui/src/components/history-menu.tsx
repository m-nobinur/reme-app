import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { MagnifyingGlassIcon } from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { formatDate } from "@workspace/ui/lib/format"
import {
  type HistoryGroup,
  historyGroup,
} from "@workspace/ui/lib/history-groups"
import { cn, META } from "@workspace/ui/lib/utils"
import {
  type ComponentProps,
  cloneElement,
  type MouseEvent,
  type ReactElement,
  useRef,
  useState,
} from "react"

/** One past conversation: its title, when it last moved, and its link. */
type HistoryEntry = {
  id: string
  title: string
  at: string
  /** The link element the row renders as, from the app's router. */
  link: ReactElement<ComponentProps<"a">>
}

/** How many rows show at first, and how many more each "Load older" adds. */
const PAGE = 12

const ROW =
  "flex min-h-10 w-full min-w-0 items-center gap-3 rounded-lg px-2.5 py-1.5 text-sm outline-none transition-colors duration-150 hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring aria-[current=page]:bg-primary/10 aria-[current=page]:font-medium motion-reduce:transition-none"

const POPUP =
  "flex max-h-[min(32rem,var(--available-height))] w-[min(22rem,calc(100vw-1.5rem))] origin-(--transform-origin) flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-starting-style:scale-95 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none"

/**
 * The search box and the conversations under it, split by day. It holds its
 * own query and page, so each time its popup opens it starts fresh.
 */
function HistoryPanel({
  items,
  current,
  close,
}: {
  /** Newest first, as the api lists them. */
  items: HistoryEntry[]
  current?: string | undefined
  /** Called when a link in the list is followed. */
  close: () => void
}) {
  const [query, setQuery] = useState("")
  const [shown, setShown] = useState(PAGE)
  const words = query.trim().toLowerCase()
  const matches = words
    ? items.filter((item) => item.title.toLowerCase().includes(words))
    : items
  const now = new Date()
  // Newest first, so each heading's rows are already together.
  const groups: { label: HistoryGroup; rows: HistoryEntry[] }[] = []
  for (const item of matches.slice(0, shown)) {
    const label = historyGroup(item.at, now)
    if (groups.at(-1)?.label === label) groups.at(-1)?.rows.push(item)
    else groups.push({ label, rows: [item] })
  }
  const followed = (event: MouseEvent) => {
    if ((event.target as Element).closest("a[href]")) close()
  }

  return (
    <>
      <div className="relative border-border border-b p-2">
        <MagnifyingGlassIcon
          aria-hidden
          className="pointer-events-none absolute start-5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label="Search your conversations"
          className="ps-9"
          onChange={(event) => {
            setQuery(event.target.value)
            setShown(PAGE)
          }}
          placeholder="Search your conversations…"
          type="search"
          value={query}
        />
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a listener for the links inside, which a keyboard activates with a click too. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above; Enter on a link is a click. */}
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1"
        onClick={followed}
      >
        {groups.length ? (
          <div className="flex flex-col gap-2">
            {groups.map((group) => (
              <section aria-label={group.label} key={group.label}>
                <h3 className={cn(META, "px-2.5 pt-2 pb-1")}>{group.label}</h3>
                <ul className="flex flex-col">
                  {group.rows.map((item) => (
                    <li key={item.id}>
                      {cloneElement(item.link, {
                        className: ROW,
                        "aria-current":
                          item.id === current ? "page" : undefined,
                        children: (
                          <>
                            <span className="min-w-0 flex-1 truncate">
                              {item.title}
                            </span>
                            <time
                              className={cn(META, "shrink-0 tabular-nums")}
                              dateTime={item.at}
                            >
                              {formatDate(item.at)}
                            </time>
                          </>
                        ),
                      })}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <p className="px-3 py-6 text-center text-muted-foreground text-sm">
            {words
              ? "No conversation has that in its title."
              : "Your conversations with Reme show here."}
          </p>
        )}
        {matches.length > shown ? (
          <Button
            className="mt-1 w-full"
            onClick={() => setShown((count) => count + PAGE)}
            size="sm"
            variant="ghost"
          >
            Load older conversations
          </Button>
        ) : null}
      </div>
    </>
  )
}

/**
 * The owner's conversations beside the rail's link to the latest chat, opened
 * by hovering it: newest first, under Today, Yesterday, This week and Older,
 * searchable by title, a page at a time. The link still goes where it goes,
 * and following it, or any row, closes the list. A touch screen has no hover
 * and takes the link; a keyboard opens the list with the right arrow. The
 * links are slots, so this package still imports no router.
 */
function ChatHistory({
  items,
  current,
  trigger,
}: {
  /** Newest first, as the api lists them. */
  items: HistoryEntry[]
  /** The conversation on screen, marked as the current page. */
  current?: string | undefined
  /** The link element, with its content. */
  trigger: ReactElement<ComponentProps<"a">>
}) {
  const [open, setOpen] = useState(false)
  // After a click the pointer is still over the link, which would open the
  // list again at once; it stays shut until the pointer has left.
  const pressed = useRef(false)
  return (
    <PopoverPrimitive.Root
      onOpenChange={(next) => {
        if (!(next && pressed.current)) setOpen(next)
      }}
      open={open}
    >
      <PopoverPrimitive.Trigger
        closeDelay={200}
        delay={150}
        onClick={() => {
          pressed.current = true
          setOpen(false)
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") setOpen(true)
        }}
        onPointerLeave={() => {
          pressed.current = false
        }}
        openOnHover
        render={trigger}
      />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          align="start"
          className="isolate z-50 outline-none"
          side="right"
          sideOffset={12}
        >
          <PopoverPrimitive.Popup
            className={POPUP}
            data-slot="chat-history-content"
          >
            <PopoverPrimitive.Title className="sr-only">
              Conversations
            </PopoverPrimitive.Title>
            <HistoryPanel
              close={() => setOpen(false)}
              current={current}
              items={items}
            />
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

export type { HistoryEntry }
export { ChatHistory }
