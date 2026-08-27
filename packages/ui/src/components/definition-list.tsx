import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps, ReactNode } from "react"

type DefinitionItem = {
  id: string
  term: string
  description: ReactNode
  /** Where the value came from, or anything else that qualifies it. */
  meta?: ReactNode
}

/**
 * Labelled values, as a real `<dl>`.
 *
 * The business profile is the screen this exists for: every row on it is a
 * canonical fact with provenance behind it (§10.2, R8), and `meta` is where
 * that provenance goes. A definition list rather than a two-column table
 * because the pairing is the meaning here; there is no second row to compare a
 * value against.
 */
function DefinitionList({
  items,
  className,
  ...props
}: Omit<ComponentProps<"dl">, "children"> & { items: DefinitionItem[] }) {
  return (
    <dl className={cn("flex flex-col gap-4", className)} {...props}>
      {items.map((item) => (
        <div className="flex flex-col gap-0.5" key={item.id}>
          <dt className="text-muted-foreground text-xs uppercase tracking-wide">
            {item.term}
          </dt>
          <dd className="text-sm">{item.description}</dd>
          {item.meta ? (
            <dd className="text-muted-foreground text-xs">{item.meta}</dd>
          ) : null}
        </div>
      ))}
    </dl>
  )
}

export type { DefinitionItem }
export { DefinitionList }
