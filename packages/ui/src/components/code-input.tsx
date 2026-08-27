import { Input } from "@workspace/ui/components/input"
import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps } from "react"

/**
 * The one-time code field. One input rather than six boxes: `autocomplete`
 * `one-time-code` is what lets iOS and Android offer the code from the SMS or
 * authenticator, and six separate boxes break it, break paste, and give a
 * screen reader six unlabelled fields to read.
 *
 * `inputMode="numeric"` raises the number pad without `type="number"`, which
 * would strip a leading zero and add spinner arrows nobody wants on a code.
 */
function CodeInput({ className, ...props }: ComponentProps<typeof Input>) {
  return (
    <Input
      autoComplete="one-time-code"
      className={cn(
        "text-center font-medium text-lg tracking-[0.4em]",
        className
      )}
      inputMode="numeric"
      maxLength={6}
      pattern="[0-9]{6}"
      spellCheck={false}
      {...props}
    />
  )
}

export { CodeInput }
