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
  type PanelAuto,
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
 * With no `panel` there is no card and no space kept for it.
 *
 * `floating`, for the pages that are not the conversation, moves the panel to
 * the bottom right as a pill that keeps no room: its line, opening upward
 * into the card, with `panelFooter` under it. It starts minimised, folds on
 * Escape or a press outside it, and a request to open from the app glows its
 * ring instead. With no `panel` there, `panelIdle` sits in its place. The
 * rail and the panel are slots, so this package still imports no router.
 */
function WorkspaceShell({
  rail,
  panel,
  panelLine,
  defaultRailOpen = true,
  defaultPanelOpen = true,
  openPanel,
  autoPanel,
  onPanelToggle,
  floating = false,
  panelFooter,
  panelFocus,
  panelIdle,
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
  /**
   * The app opened or folded the panel for the owner, at `lg` and up. It is
   * not remembered, so the next visit opens as the owner last left it.
   */
  autoPanel?: PanelAuto | undefined
  /** The owner pressed the panel's header to open or close it. */
  onPanelToggle?: ((open: boolean) => void) | undefined
  /** The panel as a pill at the bottom right, keeping no room on the page. */
  floating?: boolean
  /** Under the floating card's content, such as a way back to the chat. */
  panelFooter?: ReactNode
  /** What the owner opening the floating pill moves focus to, such as a question waiting. */
  panelFocus?: string | undefined
  /** Floating with no `panel`: what sits in its place. */
  panelIdle?: ReactNode
  children: ReactNode
  className?: string
}) {
  const [railOpen, setRailOpen] = useState(defaultRailOpen)
  const [railSheet, setRailSheet] = useState(false)
  const [panelOpen, setPanelOpen] = useState(defaultPanelOpen)
  const [narrowOpen, setNarrowOpen] = useState(false)
  const [floatOpen, setFloatOpen] = useState(false)
  const [nudge, setNudge] = useState<string | null>(null)
  const wide = useWide()
  const expanded = floating ? floatOpen : wide ? panelOpen : narrowOpen
  const panelId = useId()
  const aside = useRef<HTMLElement>(null)
  const head = useRef<HTMLButtonElement>(null)
  // Read by the stable callbacks below, so moving between pages re-runs nothing.
  const placed = useRef(floating)
  placed.current = floating
  const hasPanel = panel !== null && panel !== undefined
  const docked = hasPanel && !floating
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
    if (placed.current) {
      setFloatOpen(open)
    } else if (window.matchMedia(WIDE).matches) {
      setPanelOpen(open)
      remember(PANEL_COOKIE, open)
    } else {
      setNarrowOpen(open)
    }
  }, [])

  const autoKey = autoPanel?.key
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key is the trigger; the request is read with it.
  useEffect(() => {
    if (!autoPanel) return
    // Away from the conversation, news asks for a look rather than covering the page.
    if (autoPanel.open && placed.current) setNudge(autoPanel.key)
    else if (window.matchMedia(WIDE).matches) setPanelOpen(autoPanel.open)
  }, [autoKey])

  // The floating card folds on Escape or a press outside it, but not from a
  // dialog it opened.
  useEffect(() => {
    if (!floating || !floatOpen) return
    const fold = (event: KeyboardEvent | PointerEvent) => {
      const target = event.target as Element
      if (target.closest?.('[role="dialog"]')) return
      if (
        event instanceof KeyboardEvent
          ? event.key === "Escape"
          : !aside.current?.contains(target)
      ) {
        // Focus inside goes back to the pill rather than the page.
        if (aside.current?.contains(document.activeElement))
          head.current?.focus()
        setFloatOpen(false)
      }
    }
    document.addEventListener("keydown", fold)
    document.addEventListener("pointerdown", fold)
    return () => {
      document.removeEventListener("keydown", fold)
      document.removeEventListener("pointerdown", fold)
    }
  }, [floating, floatOpen])

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
        // --gap is the panel's margin at the top and the right, and --bar is the
        // height that centres the panel's line (42px) in the top bar, so the
        // logo in the rail sits level with it at every width.
        "flex h-svh overflow-hidden bg-background text-foreground [--bar:calc(var(--gap)*2+2.625rem)] [--gap:0.375rem] md:[--gap:0.75rem] lg:[--gap:1.125rem]",
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
            "hidden shrink-0 flex-col overflow-hidden border-border bg-rail text-rail-foreground transition-[width] duration-enter motion-reduce:transition-none md:flex",
            railOpen ? "w-16 border-r" : "w-0",
            "[&_[data-slot=rail-label]]:sr-only"
          )}
          data-state={railOpen ? "open" : "closed"}
          id="workspace-rail"
          inert={!railOpen}
        >
          <div className="flex h-(--bar) w-16 shrink-0 items-center px-3">
            <RailToggle onClick={toggleRail} open />
          </div>
          <div className="flex min-h-0 w-16 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden px-2.5 pt-2 pb-3">
            {rail}
          </div>
        </aside>
      )}

      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex h-(--bar) shrink-0 items-center gap-1 px-3">
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
          // Docked, the panel floats over the page's top right. From lg it
          // keeps `--panel-inset` free at the right, its width and a gap,
          // which the conversation leaves clear. From md its line sits in the
          // top bar, which has nothing at the right; on a phone it sits under
          // the bar, so the page starts below it. Floating, the page keeps
          // only room at its end to scroll clear of the pill.
          className={cn(
            "min-h-0 flex-1 overflow-y-auto",
            docked &&
              "max-md:pt-14 lg:[--panel-inset:calc(22rem+var(--gap)+0.5rem)]",
            floating && "pb-16"
          )}
          // The page scrolls here, not the window: the router resets and
          // restores this element by its id.
          data-panel={docked ? (expanded ? "open" : "closed") : undefined}
          data-scroll-restoration-id="main"
          id="main"
        >
          {children}
        </main>

        {hasPanel ? (
          <aside
            aria-label="Panel"
            className={cn(
              "group/panel absolute right-(--gap) z-20 flex max-w-[calc(100%-var(--gap)*2)] overflow-hidden border border-border bg-popover text-popover-foreground shadow-lg",
              floating
                ? "motion-safe:fade-in motion-safe:slide-in-from-bottom-2 bottom-(--gap) max-h-[min(70svh,40rem)] flex-col-reverse rounded-full data-[state=open]:w-88 data-[state=open]:rounded-2xl motion-safe:animate-in"
                : "top-[calc(var(--bar)+var(--gap))] max-h-[calc(50svh+3rem)] w-88 flex-col rounded-2xl md:top-(--gap)"
            )}
            data-state={expanded ? "open" : "closed"}
            id="workspace-panel"
            ref={aside}
          >
            {floating && !expanded && nudge ? (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-[inherit] opacity-0 ring-2 ring-primary ring-inset motion-safe:animate-panel-nudge"
                // A new key per request replays the glow.
                key={nudge}
              />
            ) : null}
            <button
              aria-controls={panelId}
              aria-expanded={expanded}
              className={cn(
                "flex min-h-10 w-full min-w-0 shrink-0 items-center gap-2.5 px-3.5 text-start outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset motion-reduce:transition-none",
                floating
                  ? "rounded-b-[inherit] group-data-[state=closed]/panel:rounded-t-[inherit]"
                  : "rounded-t-[inherit] group-data-[state=closed]/panel:rounded-b-[inherit]"
              )}
              onClick={() => {
                if (floating && !expanded) focusTarget.current = panelFocus
                setPanel(!expanded)
                onPanelToggle?.(!expanded)
              }}
              ref={head}
              type="button"
            >
              <span className="min-w-0 flex-1">{panelLine}</span>
              <span className="sr-only">
                {expanded ? ", minimise the panel" : ", open the panel"}
              </span>
              <CaretDownIcon
                aria-hidden
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
                  // It points the way the card opens: down from the top, up from the bottom.
                  expanded !== floating && "rotate-180"
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
                "min-h-0 flex-col gap-6 overflow-y-auto overflow-x-hidden overscroll-contain border-border px-4 pt-2 pb-4",
                floating
                  ? cn(
                      "motion-safe:fade-in motion-safe:slide-in-from-bottom-1 border-b motion-safe:animate-in",
                      floatOpen ? "flex" : "hidden"
                    )
                  : cn(
                      "border-t",
                      wide
                        ? panelOpen
                          ? "hidden lg:flex"
                          : "hidden"
                        : narrowOpen
                          ? "flex"
                          : "hidden"
                    )
              )}
              id={panelId}
              onClick={
                floating
                  ? closeOnLink(() => setFloatOpen(false))
                  : wide
                    ? undefined
                    : closeOnLink(() => setNarrowOpen(false))
              }
            >
              {panel}
              {floating && panelFooter ? (
                // Reaches down over the scroller's padding, so it stays in view.
                <div className="sticky -bottom-4 -mx-4 -mt-2 -mb-4 flex border-border border-t bg-popover px-4 py-3">
                  {panelFooter}
                </div>
              ) : null}
            </div>
          </aside>
        ) : floating && panelIdle ? (
          <div className="motion-safe:fade-in motion-safe:slide-in-from-bottom-2 absolute right-(--gap) bottom-(--gap) z-20 motion-safe:animate-in">
            {panelIdle}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The padded column a page that is not the conversation renders into, so the
 * approvals, pipeline, staff and profile screens keep the frame they had. It
 * leaves the open panel's room free from lg, so a table never runs under it.
 */
function WorkspacePage({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        // The panel floats over the page's right edge while open, and the page
        // stays centred. Its content keeps clear of the part of the panel's
        // room that the page's own side margin (the width over 64rem, the
        // max-w-5xl below, halved) does not already cover; a percentage in
        // padding is the width of main.
        "mx-auto w-full max-w-5xl px-4 pt-2 pb-10 md:px-10 lg:in-data-[panel=open]:pe-[clamp(0px,calc(var(--panel-inset,0px)_-_(100%_-_64rem)_/_2),var(--panel-inset,0px))]",
        className
      )}
      data-slot="workspace-page"
      {...props}
    />
  )
}

export { closeOnLink, WorkspacePage, WorkspaceShell }
