import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps, ReactNode } from "react"

/**
 * The frame every page in the sign-in flow renders into: one centred panel on
 * the page background, with the product name above it and a single line of
 * onward navigation below.
 *
 * It takes the wordmark and the footer as slots so this package still imports
 * no router.
 */
function AuthCard({
  brand,
  title,
  description,
  footer,
  className,
  children,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  brand?: ReactNode
  title: string
  description?: ReactNode
  footer?: ReactNode
}) {
  return (
    <div
      className={cn(
        "flex min-h-svh flex-col items-center justify-center gap-6 bg-background px-4 py-10 text-foreground",
        className
      )}
      {...props}
    >
      {brand ? (
        <div className="font-semibold tracking-tight">{brand}</div>
      ) : null}
      <main className="w-full max-w-sm rounded-3xl border border-border bg-card p-6 shadow-xs sm:p-8">
        <h1 className="font-semibold text-xl tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-1.5 text-muted-foreground text-sm">{description}</p>
        ) : null}
        <div className="mt-6">{children}</div>
      </main>
      {footer ? (
        <p className="text-muted-foreground text-sm">{footer}</p>
      ) : null}
    </div>
  )
}

/**
 * The vertical rhythm inside an AuthCard: fields, then the submit button.
 *
 * `method="post"` is not decoration. These forms submit through a server
 * function, so the handler calls `preventDefault` and the method never matters
 * — except in the window before React has hydrated, when a click still submits
 * the form natively. A form with no method defaults to GET, and a GET submit
 * puts every named field in the query string, which is where a password would
 * then sit in the address bar, the history and every access log in between.
 */
function AuthForm({ className, ...props }: ComponentProps<"form">) {
  return (
    <form
      className={cn("flex flex-col gap-4", className)}
      method="post"
      {...props}
    />
  )
}

export { AuthCard, AuthForm }
