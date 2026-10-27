import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { XIcon } from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps } from "react"

// shadcn's Base UI dialog (`shadcn add dialog`, style base-luma), cut to the
// parts the chat uses. Its overlay dims what is behind it, as the sheet's
// does, without the registry's blur.

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

/**
 * A modal panel in the middle of the screen. Base UI traps focus inside it
 * while it is open, closes it on Escape, and hands focus back when it closes.
 */
function DialogContent({
  className,
  children,
  ...props
}: DialogPrimitive.Popup.Props) {
  return (
    <DialogPrimitive.Portal data-slot="dialog-portal">
      <DialogPrimitive.Backdrop
        className="fixed inset-0 z-50 bg-foreground/20 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none dark:bg-background/70"
        data-slot="dialog-overlay"
      />
      <DialogPrimitive.Popup
        className={cn(
          "fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-6 overflow-y-auto rounded-3xl bg-popover p-6 text-popover-foreground text-sm shadow-xl outline-none ring-1 ring-foreground/5 transition duration-enter data-ending-style:scale-95 data-starting-style:scale-95 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none sm:max-w-md dark:ring-foreground/10",
          className
        )}
        data-slot="dialog-content"
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          data-slot="dialog-close"
          render={
            <Button
              className="absolute top-4 right-4 bg-secondary"
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <XIcon aria-hidden />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  )
}

function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-1.5 pe-10", className)}
      data-slot="dialog-header"
      {...props}
    />
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      className={cn(
        "font-heading font-medium text-base leading-none",
        className
      )}
      data-slot="dialog-title"
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      className={cn("text-muted-foreground text-sm", className)}
      data-slot="dialog-description"
      {...props}
    />
  )
}

export { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle }
