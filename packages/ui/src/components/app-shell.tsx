import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps, ReactNode } from "react"

/**
 * Class for a rail navigation link. The active styling keys off
 * `aria-current="page"`, which is what a router link sets when it matches, so
 * the visual state and the accessible state cannot drift apart.
 */
const navLinkClass = cn(
  "flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 text-rail-foreground text-sm outline-none transition-colors duration-150 hover:bg-foreground/5 focus-visible:ring-3 focus-visible:ring-ring aria-[current=page]:bg-primary/10 aria-[current=page]:font-medium motion-reduce:transition-none [&_svg]:size-4 [&_svg]:shrink-0 aria-[current=page]:[&_svg]:text-primary"
)

/**
 * The rail's navigation list. Children are `<li>` elements holding router
 * links, so this package still imports no router.
 */
function AppNav({ children, className, ...props }: ComponentProps<"nav">) {
  return (
    <nav className={cn("min-w-0", className)} {...props}>
      <ul className="flex flex-col gap-0.5">{children}</ul>
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

export { AppNav, navLinkClass, PageHeader }
