import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import {
  ClockCounterClockwiseIcon,
  MagnifyingGlassIcon,
} from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Hint } from "@workspace/ui/components/tooltip"
import { formatDate } from "@workspace/ui/lib/format"
import { cn, META } from "@workspace/ui/lib/utils"
import {
  type ComponentProps,
  cloneElement,
  type MouseEvent,
  type ReactElement,
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

/** How many rows show at first, and how many more each "Load more" adds. */
const PAGE = 12

const ROW =
  "flex min-h-10 w-full min-w-0 items-center gap-3 rounded-lg px-2.5 py-1.5 text-sm outline-none transition-colors duration-150 hover:bg-accent hover:text-accent-foreground focus-visible:ring-3 focus-visible:ring-ring aria-[current=page]:bg-primary/10 aria-[current=page]:font-medium motion-reduce:transition-none"

/**
 * The owner's conversations behind the clock at the top right: newest first,
 * searchable by title, a page at a time. Following a link closes it. The
 * links are slots, so this package still imports no router.
 */
function HistoryMenu({
  items,
  current,
}: {
  /** Newest first, as the api lists them. */
  items: HistoryEntry[]
  /** The conversation on screen, marked as the current page. */
  current?: string | undefined
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [shown, setShown] = useState(PAGE)
  const words = query.trim().toLowerCase()
  const matches = words
    ? items.filter((item) => item.title.toLowerCase().includes(words))
    : items
  const closeOnLink = (event: MouseEvent) => {
    if ((event.target as Element).closest("a[href]")) setOpen(false)
  }

  return (
    <PopoverPrimitive.Root
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setQuery("")
          setShown(PAGE)
        }
      }}
      open={open}
    >
      <Hint label="History">
        <PopoverPrimitive.Trigger
          render={
            <Button
              aria-label="History"
              data-slot="history-menu"
              size="icon"
              variant="ghost"
            />
          }
        >
          <ClockCounterClockwiseIcon aria-hidden />
        </PopoverPrimitive.Trigger>
      </Hint>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          align="end"
          className="isolate z-50 outline-none"
          sideOffset={4}
        >
          <PopoverPrimitive.Popup
            className="flex max-h-[min(32rem,var(--available-height))] w-[min(22rem,calc(100vw-1.5rem))] origin-(--transform-origin) flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-starting-style:scale-95 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none"
            data-slot="history-menu-content"
          >
            <PopoverPrimitive.Title className="sr-only">
              History
            </PopoverPrimitive.Title>
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
              onClick={closeOnLink}
            >
              {matches.length ? (
                <ul aria-label="Conversations" className="flex flex-col">
                  {matches.slice(0, shown).map((item) => (
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
                  Load more
                </Button>
              ) : null}
            </div>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

export type { HistoryEntry }
export { HistoryMenu }
