import { Dialog as SheetPrimitive } from "@base-ui/react/dialog"
import { XIcon } from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"

// shadcn's Base UI sheet, cut to the parts the workspace shell uses. The
// registry's overlay blurred what was behind it; this one only dims it.

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

/**
 * A modal edge panel. Base UI traps focus inside it while it is open and hands
 * focus back to the trigger when it closes, which the catalog suite asserts.
 */
function SheetContent({
  className,
  children,
  side = "right",
  ...props
}: SheetPrimitive.Popup.Props & { side?: "left" | "right" }) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Backdrop
        className="fixed inset-0 z-50 bg-foreground/20 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none dark:bg-background/70"
        data-slot="sheet-overlay"
      />
      <SheetPrimitive.Popup
        className={cn(
          "fixed inset-y-0 z-50 flex h-full w-[min(20rem,calc(100vw-3rem))] flex-col bg-rail text-rail-foreground text-sm shadow-lg outline-none transition duration-200 ease-out data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none",
          side === "left"
            ? "left-0 border-border border-r data-ending-style:-translate-x-4 data-starting-style:-translate-x-4"
            : "right-0 border-border border-l data-ending-style:translate-x-4 data-starting-style:translate-x-4",
          className
        )}
        data-side={side}
        data-slot="sheet-content"
        {...props}
      >
        {children}
        <SheetPrimitive.Close
          data-slot="sheet-close"
          render={
            <Button
              className="absolute top-2 right-2"
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <XIcon aria-hidden />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Popup>
    </SheetPrimitive.Portal>
  )
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      className={cn("font-medium text-base", className)}
      data-slot="sheet-title"
      {...props}
    />
  )
}

export { Sheet, SheetContent, SheetTitle, SheetTrigger }
