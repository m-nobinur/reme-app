import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { cn } from "@workspace/ui/lib/utils"

function Popover(props: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverTitle({ className, ...props }: PopoverPrimitive.Title.Props) {
  return (
    <PopoverPrimitive.Title
      className={cn("font-medium text-sm", className)}
      data-slot="popover-title"
      {...props}
    />
  )
}

function PopoverDescription({
  className,
  ...props
}: PopoverPrimitive.Description.Props) {
  return (
    <PopoverPrimitive.Description
      className={cn("text-muted-foreground text-xs", className)}
      data-slot="popover-description"
      {...props}
    />
  )
}

/** The panel, at the menus' radius, border and motion. */
function PopoverContent({
  align = "start",
  side = "bottom",
  sideOffset = 6,
  className,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, "align" | "side" | "sideOffset">) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner
        align={align}
        className="isolate z-50 outline-none"
        side={side}
        sideOffset={sideOffset}
      >
        <PopoverPrimitive.Popup
          className={cn(
            "flex max-h-(--available-height) w-72 max-w-(--available-width) origin-(--transform-origin) flex-col gap-2 overflow-y-auto rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-md outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-starting-style:scale-95 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none",
            className
          )}
          data-slot="popover-content"
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

export {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
}
