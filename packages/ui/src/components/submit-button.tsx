import { SpinnerGapIcon } from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps } from "react"

/**
 * The submit control for every form in the sign-in flow, with its three states
 * in one place.
 *
 * `aria-disabled` rather than `disabled`, which is the difference between a
 * keyboard user staying on the button and being dumped back to the top of the
 * document the moment they press it. The second submit is stopped in the click
 * handler instead, which matters on the sign-in form: the rate limiter allows
 * five attempts a minute per address, and a double submit spends two of them.
 *
 * `aria-busy` and the spinner are what stop a slow network reading as a dead
 * button, and the label changes with the state so the answer is in words too.
 */
function SubmitButton({
  pending = false,
  pendingLabel,
  children,
  className,
  onClick,
  ...props
}: ComponentProps<typeof Button> & {
  pending?: boolean
  /** What the button says while the request is in flight. */
  pendingLabel: string
}) {
  return (
    <Button
      aria-busy={pending || undefined}
      aria-disabled={pending || undefined}
      className={cn("w-full aria-disabled:opacity-60", className)}
      onClick={(event) => {
        if (pending) {
          event.preventDefault()
          return
        }
        onClick?.(event)
      }}
      type="submit"
      {...props}
    >
      {pending ? <SpinnerGapIcon aria-hidden className="animate-spin" /> : null}
      {pending ? pendingLabel : children}
    </Button>
  )
}

export { SubmitButton }
