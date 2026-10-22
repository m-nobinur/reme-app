import { cn } from "@workspace/ui/lib/utils"
import { type ComponentProps, useState } from "react"

const LENGTH = 6

/**
 * The one-time code field: six boxes drawn over one real input. The input is
 * what lets iOS and Android offer the code from the SMS or authenticator
 * (`autocomplete` `one-time-code`), what paste lands in, and the single field a
 * screen reader reads. Six separate inputs break all three, so the boxes are
 * `aria-hidden` and only show what the input holds.
 *
 * `inputMode="numeric"` raises the number pad without `type="number"`, which
 * would strip a leading zero and add spinner arrows nobody wants on a code.
 *
 * No `pattern` and no `maxLength`. A `pattern` would be checked by the browser,
 * which answers a half-typed code with its own bubble and its own wording; the
 * pages check the length themselves and put the answer on the field, where every
 * other error in this flow appears. A `maxLength` would cut a pasted "123 456"
 * to five digits before the spaces are stripped, so the value is cleaned and
 * cut here instead.
 */
function CodeInput({
  className,
  defaultValue,
  onChange,
  onFocus,
  onBlur,
  onSelect,
  ...props
}: Omit<ComponentProps<"input">, "value" | "maxLength">) {
  const [value, setValue] = useState(
    String(defaultValue ?? "")
      .replace(/\D/g, "")
      .slice(0, LENGTH)
  )
  const [focused, setFocused] = useState(false)
  const active = Math.min(value.length, LENGTH - 1)

  return (
    <div
      className={cn("relative flex gap-2", className)}
      data-slot="code-input"
    >
      {Array.from({ length: LENGTH }, (_, index) => (
        <div
          aria-hidden
          className={cn(
            "flex h-12 min-w-0 flex-1 items-center justify-center rounded-2xl border border-transparent bg-input/50 font-medium text-xl transition-[box-shadow,border-color]",
            focused && index === active && "border-ring ring-3 ring-ring",
            props["aria-invalid"] &&
              "border-destructive ring-3 ring-destructive"
          )}
          // biome-ignore lint/suspicious/noArrayIndexKey: the boxes are fixed positions
          key={index}
        >
          {value[index] ??
            (focused && index === active ? (
              <span className="h-5 w-px animate-pulse bg-foreground" />
            ) : null)}
        </div>
      ))}
      <input
        autoComplete="one-time-code"
        className="absolute inset-0 size-full cursor-default opacity-0 outline-none"
        inputMode="numeric"
        onBlur={(event) => {
          setFocused(false)
          onBlur?.(event)
        }}
        onChange={(event) => {
          setValue(event.target.value.replace(/\D/g, "").slice(0, LENGTH))
          onChange?.(event)
        }}
        onFocus={(event) => {
          setFocused(true)
          onFocus?.(event)
        }}
        // The caret is invisible, so keep it at the end: a click on box 2
        // should not make the next digit land in the middle.
        onSelect={(event) => {
          const end = event.currentTarget.value.length
          event.currentTarget.setSelectionRange(end, end)
          onSelect?.(event)
        }}
        spellCheck={false}
        value={value}
        {...props}
      />
    </div>
  )
}

export { CodeInput }
