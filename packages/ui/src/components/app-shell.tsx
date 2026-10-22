import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps, ReactNode } from "react"

/**
 * Class for a control in the compact rail: a 22px muted icon in a 40px
 * square, with its `data-slot="rail-label"` name beside it where the rail is
 * wide enough to show it. The current page takes the accent. A 32px mark (an
 * avatar) takes less padding.
 */
const railItemClass = cn(
  "relative flex h-10 w-full min-w-0 shrink-0 items-center gap-3 rounded-xl px-[9px] text-rail-foreground text-sm outline-none transition-colors duration-150 hover:bg-foreground/5 focus-visible:ring-3 focus-visible:ring-ring has-data-[slot=mark]:px-1 aria-[current=page]:bg-primary/10 aria-[current=page]:text-primary motion-reduce:transition-none [&_svg]:size-5.5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground hover:[&_svg]:text-foreground aria-[current=page]:[&_svg]:text-primary"
)

/** A count as it is drawn: past 99, "99+". */
const countLabel = (count: number) => (count > 99 ? "99+" : String(count))

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

export { countLabel, PageHeader, railItemClass }
