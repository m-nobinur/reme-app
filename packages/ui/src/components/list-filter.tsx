import { MagnifyingGlassIcon } from "@phosphor-icons/react"
import { Input } from "@workspace/ui/components/input"
import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps } from "react"

/**
 * The text filter every list view starts with. Presentational: the value lives
 * in the route's search params, so the caller owns reading and writing it.
 */
function ListFilter({
  label,
  value,
  onValueChange,
  className,
  id = "list-filter",
  ...props
}: Omit<ComponentProps<typeof Input>, "onChange" | "value"> & {
  label: string
  value: string
  onValueChange: (value: string) => void
}) {
  return (
    <div className={cn("relative mb-4 max-w-sm", className)}>
      <label className="sr-only" htmlFor={id}>
        {label}
      </label>
      <MagnifyingGlassIcon
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        className="pl-9"
        id={id}
        onChange={(event) => onValueChange(event.target.value)}
        placeholder={label}
        type="search"
        value={value}
        {...props}
      />
    </div>
  )
}

export { ListFilter }
