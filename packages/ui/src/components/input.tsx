import { Input as InputPrimitive } from "@base-ui/react/input"
import { cn } from "@workspace/ui/lib/utils"
import type * as React from "react"

/** The look of a text control, for a textarea or select that sits beside inputs. */
const inputStyles =
  "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base outline-none transition-[color,box-shadow,background-color] file:inline-flex file:h-7 file:border-0 file:bg-transparent file:font-medium file:text-foreground file:text-sm placeholder:text-muted-foreground focus-visible:border-field-focus disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive md:text-sm"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(inputStyles, className)}
      {...props}
    />
  )
}

export { Input, inputStyles }
