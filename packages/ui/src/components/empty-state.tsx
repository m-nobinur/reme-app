import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps, ReactNode } from "react"

/**
 * The one empty-and-error convention. `role` defaults to `status`; pass
 * `role="alert"` when the panel reports a failure rather than an absence.
 */
function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  role = "status",
  ...props
}: ComponentProps<"div"> & {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div
      role={role}
      className={cn(
        "flex flex-col items-center gap-2 rounded-3xl border border-border border-dashed px-6 py-14 text-center",
        className
      )}
      {...props}
    >
      {icon ? (
        <span className="text-muted-foreground [&_svg]:size-6">{icon}</span>
      ) : null}
      <p className="font-medium">{title}</p>
      {description ? (
        <p className="max-w-prose text-balance text-muted-foreground text-sm">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}

export { EmptyState }
