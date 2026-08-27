import { cn } from "@workspace/ui/lib/utils"
import { cva, type VariantProps } from "class-variance-authority"
import type { ComponentProps, ReactNode } from "react"

const alertVariants = cva(
  "flex items-start gap-2.5 rounded-3xl px-4 py-3 text-sm [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        info: "bg-muted text-foreground",
        error: "bg-destructive/10 text-destructive",
        success: "bg-primary/10 text-foreground",
      },
    },
    defaultVariants: { variant: "info" },
  }
)

/**
 * A message about the form as a whole, as opposed to one field. `error` gets
 * `role="alert"` so a screen reader hears it when it appears after a submit;
 * the quieter variants announce politely, which is right for a message that
 * was on the page before the reader arrived.
 */
function Alert({
  variant = "info",
  icon,
  className,
  children,
  ...props
}: ComponentProps<"div"> &
  VariantProps<typeof alertVariants> & { icon?: ReactNode }) {
  return (
    <div
      className={cn(alertVariants({ variant, className }))}
      data-slot="alert"
      role={variant === "error" ? "alert" : "status"}
      {...props}
    >
      {icon}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export { Alert, alertVariants }
