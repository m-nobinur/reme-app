import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps } from "react"

/** The one loading convention: a quiet skeleton that announces itself once. */
function LoadingState({
  label = "Loading",
  className,
  ...props
}: ComponentProps<"div"> & { label?: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn("flex flex-col gap-3", className)}
      {...props}
    >
      <span className="sr-only">{label}</span>
      <div className="h-8 w-48 animate-pulse rounded-2xl bg-muted" />
      <div className="h-32 animate-pulse rounded-3xl bg-muted" />
    </div>
  )
}

export { LoadingState }
