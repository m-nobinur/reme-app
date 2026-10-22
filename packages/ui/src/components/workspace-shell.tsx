import {
  CaretDownIcon,
  ListIcon,
  SidebarSimpleIcon,
} from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import { LogoMark } from "@workspace/ui/components/logo"
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@workspace/ui/components/sheet"
import { Hint, hintsShown } from "@workspace/ui/components/tooltip"
import {
  PANEL_COOKIE,
  type PanelPress,
  RAIL_COOKIE,
} from "@workspace/ui/lib/panel"
import { cn } from "@workspace/ui/lib/utils"
import {
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

/** A year: the choice is a preference, not a session. */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365

function remember(cookie: string, open: boolean) {
  // biome-ignore lint/suspicious/noDocumentCookie: one preference the server has to read on the next request, which the Cookie Store API cannot promise in every browser this app supports.
  document.cookie = `${cookie}=${open ? "open" : "closed"}; path=/; max-age=${COOKIE_MAX_AGE}; samesite=lax`
}

/**
 * Closes a sheet when a plain click inside it followed a link, or pressed a
 * control marked `data-leaves-panel` because it takes the owner elsewhere. A
 * modified or middle click opens the link elsewhere, so the sheet stays.
 */
function closeOnLink(close: () => void) {
  return (event: MouseEvent) => {
    const modified =
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    if (
      !modified &&
      (event.target as Element).closest("a[href], [data-leaves-panel]")
    ) {
      close()
    }
  }
}

/**
 * Closes a sheet once the viewport reaches the width where its content is
 * inline again, so the rail it holds is never missing from both.
 */
function useCloseAt(query: string, close: () => void) {
  useEffect(() => {
    const media = window.matchMedia(query)
    const onChange = () => {
      if (media.matches) {
        close()
      }
    }
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [query, close])
}

/** Tailwind's `lg`: from here the panel's open state is the remembered one. */
const WIDE = "(min-width: 64rem)"
const onWidth = (change: () => void) => {
  const media = window.matchMedia(WIDE)
  media.addEventListener("change", change)
  return () => media.removeEventListener("change", change)
}
/** Wide on the server, so the first client render matches its HTML. */
const useWide = () =>
  useSyncExternalStore(
    onWidth,
    () => window.matchMedia(WIDE).matches,
    () => true
  )

/**
 * The rail's top: the mark, which shows the sidebar icon under the pointer or
 * keyboard focus and hides or shows the rail when pressed. It sits at the head
 * of the rail while that is open and at the top left of the page once it is
 * not, in the same place.
 */
function RailToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  const label = open ? "Hide sidebar" : "Show sidebar"
  return (
    <Hint label={label} side={open ? "right" : "bottom"}>
      <button
        aria-controls="workspace-rail"
        aria-expanded={open}
        aria-label={label}
        className="group/toggle relative flex size-10 shrink-0 items-center justify-center rounded-xl text-foreground outline-none transition-colors duration-150 hover:bg-foreground/5 focus-visible:ring-3 focus-visible:ring-ring motion-reduce:transition-none"
        onClick={onClick}
        type="button"
      >
        <LogoMark className="transition-opacity duration-150 group-hover/toggle:opacity-0 group-focus-visible/toggle:opacity-0 motion-reduce:transition-none" />
        <SidebarSimpleIcon
          aria-hidden
          className="absolute size-6 text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/toggle:opacity-100 group-focus-visible/toggle:opacity-100 motion-reduce:transition-none"
        />
      </button>
    </Hint>
  )
}

/**
 * The owner workspace: a compact rail of icons, the conversation, and the
 * live panel floating at the top right.
 *
 * From `md` the rail is a 64px column of icons, each named on hover, that hides
 * with the toggle at the top left, remembered in a cookie; below `md` it is a
 * sheet from the left, where the names show beside the icons. A rail label
 * is a `data-slot="rail-label"` span. The panel is a rounded
 * card whose header is always one line of live activity (`panelLine`); open,
 * it grows with its content to half the viewport's height and scrolls past
 * that. It floats over the page rather than taking a column, so the
 * conversation stays centred. From `lg` whether it is open is remembered;
 * below `lg` it starts minimised, since there it covers the conversation.
 * With no `panel` there is no card and no space kept for it. The rail and the
 * panel are slots, so this package still imports no router.
 */
function WorkspaceShell({
  rail,
  panel,
  panelLine,
  defaultRailOpen = true,
  defaultPanelOpen = true,
  openPanel,
  children,
  className,
}: {
  rail: ReactNode
  /**
   * The panel's content. Null when the app has nothing to show on this page:
   * then there is no panel at all, and the page takes back its space.
   */
  panel: ReactNode
  /** One line of live activity: the panel's header, and all of it minimised. */
  panelLine: ReactNode
  defaultRailOpen?: boolean
  defaultPanelOpen?: boolean
  /**
   * The owner asked for the panel, by a link or from the notifications: it opens when
   * the key changes, even if they had minimised it.
   */
  openPanel?: PanelPress | undefined
  children: ReactNode
  className?: string
}) {
  const [railOpen, setRailOpen] = useState(defaultRailOpen)
  const [railSheet, setRailSheet] = useState(false)
  const [panelOpen, setPanelOpen] = useState(defaultPanelOpen)
  const [narrowOpen, setNarrowOpen] = useState(false)
  const wide = useWide()
  const expanded = wide ? panelOpen : narrowOpen
  const panelId = useId()
  const hasPanel = panel !== null && panel !== undefined
  // Tailwind's `md`, the width the sheet hands the rail back to the layout.
  useCloseAt(
    "(min-width: 48rem)",
    useCallback(() => setRailSheet(false), [])
  )

  const toggleRail = () => {
    const next = !railOpen
    setRailOpen(next)
    remember(RAIL_COOKIE, next)
  }

  const setPanel = useCallback((open: boolean) => {
    if (window.matchMedia(WIDE).matches) {
      setPanelOpen(open)
      remember(PANEL_COOKIE, open)
    } else {
      setNarrowOpen(open)
    }
  }, [])

  // Sent here to the panel: open it, whatever the width, then move focus to
  // what the owner came for once it shows.
  const focusTarget = useRef<string | undefined>(undefined)
  const pressKey = openPanel?.key
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key is the trigger; the target is read with it.
  useEffect(() => {
    if (!pressKey) return
    focusTarget.current = openPanel?.focus
    setPanel(true)
  }, [pressKey, setPanel])
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new press with the panel already open has to focus too.
  useEffect(() => {
    const target = focusTarget.current
    if (!expanded || !target) return
    focusTarget.current = undefined
    const element = document.getElementById(target)
    element?.focus({ preventScroll: true })
    element?.scrollIntoView({ block: "nearest" })
  }, [expanded, pressKey])

  return (
    <div
      className={cn(
        "flex h-svh overflow-hidden bg-background text-foreground",
        className
      )}
      data-slot="workspace-shell"
    >
      <a
        className="sr-only z-10 rounded-lg bg-background px-3 py-2 font-medium text-sm ring-3 ring-ring focus:not-sr-only focus:absolute focus:m-2"
        href="#main"
      >
        Skip to content
      </a>

      {/* One copy of the rail at a time: while the sheet holds it, the inline
          one (hidden below md anyway) is not rendered, so no id repeats.
          Collapsed, it is inert, so nothing in it takes focus. */}
      {railSheet ? null : (
        <aside
          aria-label="Workspace"
          className={cn(
            "hidden shrink-0 flex-col overflow-hidden border-border bg-rail text-rail-foreground transition-[width] duration-200 ease-out motion-reduce:transition-none md:flex",
            railOpen ? "w-16 border-r" : "w-0",
            "[&_[data-slot=rail-label]]:sr-only"
          )}
          data-state={railOpen ? "open" : "closed"}
          id="workspace-rail"
          inert={!railOpen}
        >
          <div className="flex h-18.5 w-16 shrink-0 items-center px-3">
            <RailToggle onClick={toggleRail} open />
          </div>
          <div className="flex min-h-0 w-16 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden px-2.5 pt-2 pb-3">
            {rail}
          </div>
        </aside>
      )}

      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-18.5 shrink-0 items-center gap-1 px-3">
          <Sheet onOpenChange={setRailSheet} open={railSheet}>
            <SheetTrigger
              render={
                <Button
                  aria-label="Show menu"
                  className="md:hidden"
                  size="icon"
                  variant="ghost"
                />
              }
            >
              <ListIcon aria-hidden />
            </SheetTrigger>
            <SheetContent
              onClick={closeOnLink(() => setRailSheet(false))}
              side="left"
            >
              <SheetTitle className="sr-only">Workspace</SheetTitle>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3 pt-12">
                <hintsShown.Provider value={false}>{rail}</hintsShown.Provider>
              </div>
            </SheetContent>
          </Sheet>

          {railOpen ? null : (
            <span className="max-md:hidden">
              <RailToggle onClick={toggleRail} open={false} />
            </span>
          )}
        </header>

        <main
          // The panel floats over the page's top right. From lg it keeps
          // `--panel-inset` free at the right, its width and a gap, which the
          // conversation leaves clear; below lg its line sits under the bar,
          // so the page starts below it.
          className={cn(
            "min-h-0 flex-1 overflow-y-auto",
            hasPanel && "max-lg:pt-14 lg:[--panel-inset:23.5rem]"
          )}
          // The page scrolls here, not the window: the router resets and
          // restores this element by its id.
          data-scroll-restoration-id="main"
          id="main"
        >
          {children}
        </main>

        {hasPanel ? (
          <aside
            aria-label="Panel"
            className="absolute top-21 right-4 z-20 flex max-h-[calc(50svh+3rem)] w-[min(22rem,calc(100%-2rem))] flex-col overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-lg lg:top-4"
            data-state={expanded ? "open" : "closed"}
            id="workspace-panel"
          >
            <button
              aria-controls={panelId}
              aria-expanded={expanded}
              className="flex min-h-10 w-full min-w-0 shrink-0 items-center gap-2.5 px-3.5 text-start outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset motion-reduce:transition-none"
              onClick={() => setPanel(!expanded)}
              type="button"
            >
              <span className="min-w-0 flex-1">{panelLine}</span>
              <span className="sr-only">
                {expanded ? ", minimise the panel" : ", open the panel"}
              </span>
              <CaretDownIcon
                aria-hidden
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
                  expanded && "rotate-180"
                )}
              />
            </button>
            {/* Kept mounted while minimised, so a half-written answer or a
              chosen tab survives it. The server renders it open from lg,
              where the cookie says so, and minimised below. */}
            {/* biome-ignore lint/a11y/noStaticElementInteractions: a listener for the links inside, which a keyboard activates with a click too. */}
            {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above; Enter on a link is a click. */}
            <div
              className={cn(
                "min-h-0 flex-col gap-6 overflow-y-auto overscroll-contain border-border border-t p-4",
                wide
                  ? panelOpen
                    ? "hidden lg:flex"
                    : "hidden"
                  : narrowOpen
                    ? "flex"
                    : "hidden"
              )}
              id={panelId}
              onClick={
                wide ? undefined : closeOnLink(() => setNarrowOpen(false))
              }
            >
              {panel}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The padded column a page that is not the conversation renders into, so the
 * approvals, pipeline, staff and profile screens keep the frame they had.
 */
function WorkspacePage({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-5xl px-4 pt-2 pb-10 md:px-10",
        className
      )}
      data-slot="workspace-page"
      {...props}
    />
  )
}

export { closeOnLink, WorkspacePage, WorkspaceShell }
