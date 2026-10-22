import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import { cn } from "@workspace/ui/lib/utils"
import * as React from "react"

function TooltipProvider({
  // Hover intent, not instant: a tooltip that fires the moment the pointer
  // crosses an icon fires on every pointer that is only passing through.
  delay = 300,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  )
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  container,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Portal.Props, "container"> &
  Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <TooltipPrimitive.Portal container={container}>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-open:fade-in-0 data-open:zoom-in-95 data-closed:fade-out-0 data-closed:zoom-out-95 z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center gap-1.5 rounded-xl bg-foreground px-3 py-1.5 text-background text-xs has-data-[slot=kbd]:pr-1.5 data-[state=delayed-open]:animate-in data-closed:animate-out data-open:animate-in **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-lg",
            className
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground data-[side=bottom]:top-1 data-[side=inline-end]:top-1/2! data-[side=inline-start]:top-1/2! data-[side=left]:top-1/2! data-[side=right]:top-1/2! data-[side=inline-start]:-right-1 data-[side=left]:-right-1 data-[side=top]:-bottom-2.5 data-[side=inline-end]:-left-1 data-[side=right]:-left-1 data-[side=inline-end]:translate-x-[1.5px] data-[side=inline-start]:translate-x-[-1.5px] data-[side=left]:translate-x-[-1.5px] data-[side=right]:translate-x-[1.5px] data-[side=inline-end]:-translate-y-1/2 data-[side=inline-start]:-translate-y-1/2 data-[side=left]:-translate-y-1/2 data-[side=right]:-translate-y-1/2" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

/**
 * Whether a `Hint` shows. False where the names are already on screen, such
 * as the rail in its phone sheet, so Escape closes the sheet rather than a
 * hint first.
 */
const hintsShown = React.createContext(true)

/**
 * The name of a control that shows only an icon, on hover and on focus.
 * `children` is the control itself; it keeps its own `aria-label`. A
 * `detail` adds a short second line under the name, such as why a control
 * is not available yet.
 */
function Hint({
  label,
  detail,
  side = "bottom",
  children,
}: {
  label: string
  detail?: string
  side?: TooltipPrimitive.Positioner.Props["side"]
  children: React.ReactElement
}) {
  return (
    <Tooltip disabled={!React.useContext(hintsShown)}>
      <TooltipTrigger render={children} />
      {detail ? (
        <TooltipContent className="max-w-60 py-2" side={side}>
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{label}</span>
            <span className="text-background/75 leading-snug">{detail}</span>
          </span>
        </TooltipContent>
      ) : (
        <TooltipContent side={side}>{label}</TooltipContent>
      )}
    </Tooltip>
  )
}

export {
  Hint,
  hintsShown,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
}
