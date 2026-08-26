import { cn } from "@workspace/ui/lib/utils"
import { type ComponentProps, type ReactNode, useEffect, useRef } from "react"

/**
 * The frame every authenticated screen renders into: a sidebar that becomes a
 * top bar below `md`, and one `<main>` landmark. The sidebar takes its content
 * as a slot so this package never imports a router.
 */
function AppShell({
  sidebar,
  children,
  className,
  ...props
}: ComponentProps<"div"> & { sidebar: ReactNode }) {
  return (
    <div
      className={cn(
        "min-h-svh bg-background text-foreground md:grid md:grid-cols-[15rem_1fr]",
        className
      )}
      {...props}
    >
      <a
        href="#main"
        className="sr-only z-10 rounded-2xl bg-card px-3 py-2 font-medium text-sm shadow-sm ring-3 ring-ring/30 focus:not-sr-only focus:absolute focus:m-2"
      >
        Skip to content
      </a>
      <aside className="flex flex-col gap-6 border-border border-b bg-sidebar p-3 text-sidebar-foreground md:sticky md:top-0 md:h-svh md:border-r md:border-b-0">
        {sidebar}
      </aside>
      <main
        id="main"
        className="mx-auto w-full min-w-0 max-w-5xl px-4 py-6 md:px-10 md:py-10"
      >
        {children}
      </main>
    </div>
  )
}

/**
 * Class for a sidebar navigation link. The active styling keys off
 * `aria-current="page"`, which is what a router link sets when it matches, so
 * the visual state and the accessible state cannot drift apart.
 */
const navLinkClass = cn(
  "flex items-center gap-2 rounded-2xl px-3 py-2 text-sidebar-foreground/70 text-sm outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-3 focus-visible:ring-ring/30 aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0"
)

/**
 * The sidebar navigation list. Below `md` it is a horizontally scrolling row,
 * where the active item can start off-screen, so it is scrolled into view when
 * the route changes. Children are `<li>` elements; the active one is found by
 * `aria-current="page"`, which is what a router link sets, so this package
 * still imports no router.
 */
function AppNav({
  activeKey,
  children,
  className,
  ...props
}: ComponentProps<"nav"> & { activeKey: string }) {
  const listRef = useRef<HTMLUListElement | null>(null)

  // An effect, not a layout effect: it must not run during SSR, where there is
  // no DOM. The overflow check makes it a no-op on desktop, where the list is a
  // column and the only scrollable ancestor is the page itself. Instant rather
  // than smooth, so there is no motion to have to opt out of.
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeKey is the trigger, not an input. Without it this would re-run on every render and yank the nav back after the reader had scrolled it themselves.
  useEffect(() => {
    const list = listRef.current
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome reads RefObject.current as non-nullable here; tsc does not, and tsc is right.
    if (!list || list.scrollWidth <= list.clientWidth) {
      return
    }
    list
      .querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [activeKey])

  return (
    <nav className={cn("min-w-0", className)} {...props}>
      <ul
        className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible"
        ref={listRef}
      >
        {children}
      </ul>
    </nav>
  )
}

/** The heading block at the top of every screen. */
function PageHeader({
  title,
  description,
  actions,
  className,
  ...props
}: ComponentProps<"header"> & {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <header
      className={cn("mb-6 flex items-start justify-between gap-4", className)}
      {...props}
    >
      <div className="min-w-0">
        <h1 className="font-semibold text-2xl tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-prose text-muted-foreground text-sm">
            {description}
          </p>
        ) : null}
      </div>
      {actions}
    </header>
  )
}

export { AppNav, AppShell, navLinkClass, PageHeader }
