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
 *
 * No `pattern`. It would be checked by the browser, which answers a half-typed
 * code with its own bubble and its own wording ("Please match the requested
 * format"), in place of the sentence the page would have written. The pages
 * check the length themselves and put the answer on the field, where every
 * other error in this flow appears.
 */
function CodeInput({ className, ...props }: ComponentProps<typeof Input>) {
  return (
    <Input
      autoComplete="one-time-code"
      className={cn(
        "text-center font-medium text-lg tracking-[0.4em] placeholder:tracking-[0.4em]",
        className
      )}
      inputMode="numeric"
      maxLength={6}
      placeholder="000000"
      spellCheck={false}
      {...props}
    />
  )
}

export { CodeInput }
