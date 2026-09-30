import type { Icon } from "@phosphor-icons/react"
import { Input } from "@workspace/ui/components/input"
import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps, ReactNode } from "react"

/** What a caller-supplied control has to carry for the label and error to reach it. */
type FieldWiring = {
  id: string
  "aria-describedby": string | undefined
  "aria-invalid": true | undefined
}

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
  icon: FieldIcon,
  className,
  children,
  ...props
  // `children` is dropped from the input's own props rather than narrowed: an
  // intersection with `ReactNode` would leave the render-prop branch below
  // unassignable.
}: Omit<ComponentProps<typeof Input>, "id" | "children"> & {
  label: string
  hint?: ReactNode
  error?: string
  id: string
  /** A glyph inside the start of the input, saying what goes in it. */
  icon?: Icon
  /**
   * Rendered in place of the default input, for a control this file does not
   * own. Given a function, it is handed the wiring to spread on whatever it
   * renders — which is the only way a caller gets the describedby ids without
   * rebuilding `${id}-hint` from the outside and drifting from it.
   */
  children?: ReactNode | ((wiring: FieldWiring) => ReactNode)
}) {
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") ||
    undefined
  const wiring: FieldWiring = {
    id,
    "aria-describedby": describedBy,
    "aria-invalid": error ? true : undefined,
  }

  return (
    <div className={cn("flex flex-col gap-2", className)} data-slot="field">
      <label className="text-sm" htmlFor={id}>
        {label}
      </label>
      <div
        className={cn("relative", FieldIcon && "[&_[data-slot=input]]:pl-10")}
      >
        {FieldIcon ? (
          <FieldIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3.5 z-10 size-4.5 -translate-y-1/2 text-muted-foreground"
          />
        ) : null}
        {typeof children === "function" ? children(wiring) : children}
        {children ? null : <Input {...wiring} {...props} />}
      </div>
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

export type { FieldWiring }
export { Field }
