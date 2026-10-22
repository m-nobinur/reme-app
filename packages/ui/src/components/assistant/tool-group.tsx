import { type MessagePrimitive, useScrollLock } from "@assistant-ui/react"
import { CaretDownIcon } from "@phosphor-icons/react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import { StatusLine } from "@workspace/ui/components/status-line"
import { cn } from "@workspace/ui/lib/utils"
import {
  type FC,
  type PropsWithChildren,
  useCallback,
  useRef,
  useState,
} from "react"

type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart

const ANIMATION_DURATION = 200

type ToolGroupRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> & {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultOpen?: boolean
}

function ToolGroupRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  children,
  ...props
}: ToolGroupRootProps) {
  const collapsibleRef = useRef<HTMLDivElement>(null)
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION)

  const isControlled = controlledOpen !== undefined
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen

  const handleOpenChange = useCallback(
    (open: boolean) => {
      lockScroll()
      if (!isControlled) {
        setUncontrolledOpen(open)
      }
      controlledOnOpenChange?.(open)
    },
    [lockScroll, isControlled, controlledOnOpenChange]
  )

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="tool-group-root"
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn(
        "aui-tool-group-root group/tool-group-root w-full",
        className
      )}
      style={
        {
          "--animation-duration": `${ANIMATION_DURATION}ms`,
        } as React.CSSProperties
      }
      {...props}
    >
      {children}
    </Collapsible>
  )
}

function ToolGroupTrigger({
  count,
  active = false,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  count: number
  active?: boolean
}) {
  // The owner's words: the assistant checks things, it does not "call
  // tools". Present tense while it still is, past once it has.
  const label = `${active ? "Checking" : "Checked"} ${count} ${count === 1 ? "thing" : "things"}`

  return (
    <CollapsibleTrigger
      data-slot="tool-group-trigger"
      className={cn(
        "aui-tool-group-trigger group/trigger flex items-center gap-2 px-1 py-1.5 text-chat-step text-muted-foreground transition-colors hover:text-foreground active:translate-y-px",
        "rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring",
        className
      )}
      {...props}
    >
      <span
        data-slot="tool-group-trigger-label"
        className="aui-tool-group-trigger-label-wrapper inline-block text-start leading-none"
      >
        {/* A trigger is a control, so it is there from the first paint. */}
        <StatusLine
          announce={false}
          delay={0}
          kind="check"
          label={label}
          state={active ? "working" : "done"}
        />
      </span>
      <CaretDownIcon
        data-slot="tool-group-trigger-chevron"
        className={cn(
          "aui-tool-group-trigger-chevron size-3 shrink-0",
          "transition-transform duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
          "-rotate-90",
          "group-data-open/trigger:rotate-0",
          "group-data-panel-open/trigger:rotate-0"
        )}
      />
    </CollapsibleTrigger>
  )
}

function ToolGroupContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      data-slot="tool-group-content"
      className={cn(
        "aui-tool-group-content relative overflow-hidden text-sm outline-none",
        "group/collapsible-content ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
        "data-closed:animate-collapsible-up",
        "data-open:animate-collapsible-down",
        "data-closed:fill-mode-forwards",
        "data-closed:pointer-events-none",
        "[--tw-duration:var(--animation-duration)]",
        className
      )}
      {...props}
    >
      <div
        className={cn(
          "mt-1 flex flex-col gap-1",
          "[&>*]:fade-in-0 [&>*]:slide-in-from-top-1 [&>*]:animation-duration-(--animation-duration) [&>*]:animate-in [&>*]:blur-in-[2px] [&>*]:ease-[cubic-bezier(0.32,0.72,0,1)]",
          "[&>*]:motion-reduce:animate-none",
          "[&>*:nth-child(2)]:[animation-delay:40ms]",
          "[&>*:nth-child(3)]:[animation-delay:80ms]",
          "[&>*:nth-child(4)]:[animation-delay:120ms]",
          "[&>*:nth-child(n+5)]:[animation-delay:160ms]"
        )}
      >
        {children}
      </div>
    </CollapsibleContent>
  )
}

/**
 * A consecutive run of tool calls, as one disclosure. This is the shape
 * `Thread`'s `ToolGroup` slot passes, so the composition lives here rather than
 * inline in the thread.
 */
const ToolGroup: FC<PropsWithChildren<{ group: ThreadGroupPart }>> = ({
  group,
  children,
}) => {
  // A "1 tool call" disclosure wrapping one tool call's own disclosure costs
  // the reader two taps to see one thing. Group only what there is a group of.
  if (group.indices.length < 2) return children

  return (
    <ToolGroupRoot>
      <ToolGroupTrigger
        active={group.status.type === "running"}
        count={group.indices.length}
      />
      <ToolGroupContent>{children}</ToolGroupContent>
    </ToolGroupRoot>
  )
}
ToolGroup.displayName = "ToolGroup"

export { ToolGroup }
