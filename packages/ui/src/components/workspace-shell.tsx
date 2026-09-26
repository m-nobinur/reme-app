import { ListIcon, SidebarSimpleIcon } from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@workspace/ui/components/sheet"
import { PANEL_COOKIE } from "@workspace/ui/lib/panel"
import { cn } from "@workspace/ui/lib/utils"
import {
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react"

/** A year: the choice is a preference, not a session. */
const PANEL_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

/**
 * Closes a sheet when a plain click inside it followed a link. A modified or
 * middle click opens the link elsewhere, so the sheet stays.
 */
function closeOnLink(close: () => void) {
  return (event: MouseEvent) => {
    const modified =
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    if (!modified && (event.target as Element).closest("a[href]")) {
      close()
    }
  }
}

/**
 * Closes a sheet once the viewport reaches the width where its content is
 * inline again, so the rail or panel it holds is never missing from both.
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

/**
 * The owner workspace: a 15rem rail, the conversation, and a 20rem panel.
 *
 * Below `md` the rail is a sheet from the left, and below `lg` the panel is a
 * sheet from the right. Both toggles sit top right. `panelCount` is what the
 * panel is waiting on the owner for; the phone toggle shows it, because there
 * the panel is out of sight. The rail and the panel are slots, so this package
 * still imports no router. `title` and `menu` name the page in the top bar,
 * which on a phone is the only place it is named above the fold.
 */
function WorkspaceShell({
  rail,
  panel,
  panelCount = 0,
  defaultPanelOpen = true,
  title,
  menu,
  children,
  className,
}: {
  rail: ReactNode
  panel: ReactNode
  title?: string | undefined
  /** The page's ··· menu, drawn beside the title. */
  menu?: ReactNode
  panelCount?: number
  defaultPanelOpen?: boolean
  children: ReactNode
  className?: string
}) {
  const [panelOpen, setPanelOpen] = useState(defaultPanelOpen)
  const [railSheet, setRailSheet] = useState(false)
  const [panelSheet, setPanelSheet] = useState(false)
  // Tailwind's `md` and `lg`, the widths the sheets hand back to the layout.
  useCloseAt(
    "(min-width: 48rem)",
    useCallback(() => setRailSheet(false), [])
  )
  useCloseAt(
    "(min-width: 64rem)",
    useCallback(() => setPanelSheet(false), [])
  )

  const togglePanel = () => {
    const next = !panelOpen
    setPanelOpen(next)
    // biome-ignore lint/suspicious/noDocumentCookie: one preference the server has to read on the next request, which the Cookie Store API cannot promise in every browser this app supports.
    document.cookie = `${PANEL_COOKIE}=${next ? "open" : "closed"}; path=/; max-age=${PANEL_COOKIE_MAX_AGE}; samesite=lax`
  }

  const waiting =
    panelCount > 0 ? `Show panel, ${panelCount} waiting on you` : "Show panel"

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
          one (hidden below md anyway) is not rendered, so no id repeats. */}
      {railSheet ? null : (
        <aside
          aria-label="Workspace"
          className="hidden w-60 shrink-0 flex-col border-border border-r bg-rail text-rail-foreground md:flex"
        >
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
            {rail}
          </div>
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-1 px-2">
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
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3 pt-12">
                {rail}
              </div>
            </SheetContent>
          </Sheet>

          <div className="flex min-w-0 flex-1 items-center gap-0.5 md:ps-2">
            {title ? (
              <p
                className="truncate font-medium text-sm"
                data-slot="workspace-title"
              >
                {title}
              </p>
            ) : null}
            {menu}
          </div>

          <Button
            aria-controls="workspace-panel"
            aria-expanded={panelOpen}
            aria-label={panelOpen ? "Hide panel" : "Show panel"}
            className="hidden lg:inline-flex"
            onClick={togglePanel}
            size="icon"
            variant="ghost"
          >
            <SidebarSimpleIcon aria-hidden className="-scale-x-100" />
          </Button>

          <Sheet onOpenChange={setPanelSheet} open={panelSheet}>
            <SheetTrigger
              render={
                <Button
                  aria-label={waiting}
                  className="relative lg:hidden"
                  size="icon"
                  variant="ghost"
                />
              }
            >
              <SidebarSimpleIcon aria-hidden className="-scale-x-100" />
              {panelCount > 0 ? (
                <span
                  aria-hidden
                  className="absolute -top-0.5 -right-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 font-medium text-[0.8125rem] text-primary-foreground tabular-nums leading-none"
                  data-slot="panel-count"
                >
                  {panelCount}
                </span>
              ) : null}
            </SheetTrigger>
            <SheetContent onClick={closeOnLink(() => setPanelSheet(false))}>
              <SheetTitle className="sr-only">Panel</SheetTitle>
              <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4 pt-12">
                {panel}
              </div>
            </SheetContent>
          </Sheet>
        </header>

        <main
          className="min-h-0 flex-1 overflow-y-auto"
          // The page scrolls here, not the window: the router resets and
          // restores this element by its id.
          data-scroll-restoration-id="main"
          id="main"
        >
          {children}
        </main>
      </div>

      {panelSheet ? null : (
        <aside
          aria-label="Panel"
          className={cn(
            "hidden w-80 shrink-0 flex-col border-border border-l bg-rail text-rail-foreground",
            panelOpen && "lg:flex"
          )}
          id="workspace-panel"
        >
          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
            {panel}
          </div>
        </aside>
      )}
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

export { WorkspacePage, WorkspaceShell }
