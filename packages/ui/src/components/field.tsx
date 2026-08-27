import { Input } from "@workspace/ui/components/input"
import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps, ReactNode } from "react"

/**
 * A labelled input with its hint and its error, wired together.
 *
 * The wiring is the point. `aria-describedby` has to name the hint and the
 * error, `aria-invalid` has to follow the error, and the error has to be
 * announced when it appears rather than only being visible. Doing that per
 * screen is how one of eight forms ends up with an error no screen reader
 * reads, so it is done once here and the screens pass a string.
 */
function Field({
  label,
  hint,
  error,
  id,
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof Input>, "id"> & {
  label: string
  hint?: ReactNode
  error?: string
  id: string
  /** Rendered in place of the default input, for a control this file does not own. */
  children?: ReactNode
}) {
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") ||
    undefined

  return (
    <div className={cn("flex flex-col gap-1.5", className)} data-slot="field">
      <label className="font-medium text-sm" htmlFor={id}>
        {label}
      </label>
      {children ?? (
        <Input
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          id={id}
          {...props}
        />
      )}
      {hint ? (
        <p className="text-muted-foreground text-xs" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="text-destructive text-xs" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export { Field }
