import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { cn } from "@workspace/ui/lib/utils"

/** An on/off setting on Base UI's switch. Give it a visible label with `aria-labelledby`. */
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "inline-flex h-6 w-10 shrink-0 items-center rounded-full border border-transparent bg-input p-0.5 outline-none transition-colors duration-fast focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-checked:bg-primary motion-reduce:transition-none",
        className
      )}
      data-slot="switch"
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-5 rounded-full bg-background shadow-sm transition-transform duration-fast data-checked:translate-x-4 motion-reduce:transition-none" />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
