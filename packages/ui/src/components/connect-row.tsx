import { ArrowSquareOutIcon, CaretRightIcon } from "@phosphor-icons/react"
import { BrandMark } from "@workspace/ui/components/brand-mark"
import { cn } from "@workspace/ui/lib/utils"
import { type ReactNode, useId } from "react"

/**
 * One service to connect or open: its logo on a white tile, its name and one
 * muted line saying what it does, and the whole row is the link. Every row
 * goes somewhere, so it is a native link; Base UI has no link primitive to
 * put under it. A new tab says so to a screen reader and keeps no referrer;
 * the same tab keeps it, which is how Google's start route finds the chat to
 * come back to.
 */
export function ConnectRow({
  name,
  line,
  href,
  newTab = false,
  onClick,
  className,
}: {
  name: string
  line: string
  href: string
  newTab?: boolean
  onClick?: () => void
  className?: string
}) {
  const Trail = newTab ? ArrowSquareOutIcon : CaretRightIcon
  return (
    <a
      className={cn(
        "group/connect flex items-center gap-3 rounded-2xl border border-border bg-card p-2 pe-4 text-card-foreground outline-none transition-colors duration-fast hover:border-foreground/25 hover:bg-foreground/5 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring forced-colors:focus-visible:outline-2 forced-colors:focus-visible:outline-solid",
        className
      )}
      data-slot="connect-row"
      href={href}
      onClick={onClick}
      {...(newTab && { rel: "noopener noreferrer", target: "_blank" })}
    >
      <BrandMark name={name} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium text-sm">{name}</span>
        <span className="text-muted-foreground text-sm">{line}</span>
      </span>
      <Trail
        aria-hidden
        className="size-4 shrink-0 text-muted-foreground transition-colors duration-fast group-hover/connect:text-foreground"
      />
      {newTab ? <span className="sr-only"> (opens in a new tab)</span> : null}
    </a>
  )
}

/** Rows that belong together, on one rounded panel under a small heading. */
export function ConnectRows({
  heading,
  children,
}: {
  heading: string
  children: ReactNode
}) {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className="flex flex-col gap-2 rounded-3xl border border-border bg-muted/40 p-2"
      data-slot="connect-rows"
    >
      <h3
        className="px-2 pt-1 font-medium text-muted-foreground text-xs"
        id={id}
      >
        {heading}
      </h3>
      {children}
    </section>
  )
}
