import {
  type MessagePrimitive,
  type ReasoningMessagePartComponent,
  useScrollLock,
} from "@assistant-ui/react"
import { BrainIcon, CaretDownIcon } from "@phosphor-icons/react"
import { MarkdownText } from "@workspace/ui/components/assistant/markdown-text"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import { cn } from "@workspace/ui/lib/utils"
import {
  createContext,
  type FC,
  memo,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"

type ThreadGroupPart = MessagePrimitive.GroupedParts.GroupPart

const ANIMATION_DURATION = 200

const ReasoningPreviewContext = createContext(false)

type ReasoningRootProps = Omit<
  React.ComponentProps<typeof Collapsible>,
  "open" | "onOpenChange"
> & {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  defaultOpen?: boolean
  /**
   * Whether the reasoning is currently streaming. While `true` the
   * disclosure is held open with a bottom-pinned live preview; when
   * streaming ends it returns to `defaultOpen`, and the first manual
   * toggle takes over the open/close state permanently. The live preview
   * keeps following the newest tokens while the disclosure is open during
   * streaming, even after a manual toggle, and pauses while the reader is
   * scrolled up.
   */
  streaming?: boolean
}

function ReasoningRoot({
  className,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  defaultOpen = false,
  streaming,
  children,
  ...props
}: ReasoningRootProps) {
  const collapsibleRef = useRef<HTMLDivElement>(null)
  const initialOpenRef = useRef(defaultOpen)
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const lockScroll = useScrollLock(collapsibleRef, ANIMATION_DURATION)

  const isControlled = controlledOpen !== undefined
  const isOpen = isControlled
    ? controlledOpen
    : (userOpen ?? (streaming || initialOpenRef.current))
  const isPreview = streaming === true && isOpen

  const prevStreamingRef = useRef(streaming)
  useLayoutEffect(() => {
    if (prevStreamingRef.current === streaming) return
    prevStreamingRef.current = streaming
    // A streaming transition only animates the panel when the resting state
    // is collapsed; with `defaultOpen` the disclosure stays open across it.
    if (!isControlled && userOpen === null && !initialOpenRef.current) {
      lockScroll()
    }
  }, [streaming, isControlled, userOpen, lockScroll])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      lockScroll()
      if (!isControlled) {
        setUserOpen(open)
      }
      controlledOnOpenChange?.(open)
    },
    [lockScroll, isControlled, controlledOnOpenChange]
  )

  return (
    <Collapsible
      ref={collapsibleRef}
      data-slot="reasoning-root"
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={cn(
        "group/reasoning-root aui-reasoning-root mb-4 w-full rounded-3xl border px-4 py-2.5",
        className
      )}
      style={
        {
          "--animation-duration": `${ANIMATION_DURATION}ms`,
        } as React.CSSProperties
      }
      {...props}
    >
      <ReasoningPreviewContext.Provider value={isPreview}>
        {children}
      </ReasoningPreviewContext.Provider>
    </Collapsible>
  )
}

function ReasoningFade({
  side = "bottom",
  className,
  ...props
}: React.ComponentProps<"div"> & { side?: "top" | "bottom" }) {
  if (side === "top") {
    return (
      <div
        data-slot="reasoning-fade"
        className={cn(
          "aui-reasoning-fade pointer-events-none absolute inset-x-0 top-0 z-10 h-8",
          "bg-[linear-gradient(to_bottom,var(--color-background),transparent)]",
          "fade-in-0 animate-in",
          "animation-duration-(--animation-duration)",
          className
        )}
        {...props}
      />
    )
  }

  return (
    <div
      data-slot="reasoning-fade"
      className={cn(
        "aui-reasoning-fade pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8",
        "bg-[linear-gradient(to_top,var(--color-background),transparent)]",
        "fade-in-0 animate-in",
        "animation-duration-(--animation-duration)",
        className
      )}
      {...props}
    />
  )
}

function ReasoningTrigger({
  active,
  duration,
  className,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger> & {
  active?: boolean
  duration?: number
}) {
  const durationText = duration ? ` (${duration}s)` : ""

  return (
    <CollapsibleTrigger
      data-slot="reasoning-trigger"
      className={cn(
        "aui-reasoning-trigger group/trigger flex max-w-[75%] items-center gap-2 px-1 py-1.5 text-chat-step text-muted-foreground transition-colors hover:text-foreground active:translate-y-px",
        "rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring",
        className
      )}
      {...props}
    >
      <BrainIcon
        data-slot="reasoning-trigger-icon"
        className="aui-reasoning-trigger-icon size-4 shrink-0"
      />
      <span
        data-slot="reasoning-trigger-label"
        className={cn(
          "aui-reasoning-trigger-label-wrapper inline-block tabular-nums leading-none",
          active && "shimmer motion-reduce:animate-none"
        )}
      >
        Reasoning{durationText}
      </span>
      <CaretDownIcon
        data-slot="reasoning-trigger-chevron"
        className={cn(
          "aui-reasoning-trigger-chevron mt-0.5 size-4 shrink-0",
          "transition-transform duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
          "-rotate-90",
          "group-data-open/trigger:rotate-0",
          "group-data-panel-open/trigger:rotate-0"
        )}
      />
    </CollapsibleTrigger>
  )
}

function ReasoningContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsibleContent>) {
  const isPreview = useContext(ReasoningPreviewContext)

  return (
    <CollapsibleContent
      data-slot="reasoning-content"
      className={cn(
        "aui-reasoning-content relative overflow-hidden text-muted-foreground text-sm outline-none",
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
      <ReasoningFade side="top" />
      {children}
      {isPreview ? <ReasoningFade /> : null}
    </CollapsibleContent>
  )
}

function ReasoningText({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const isPreview = useContext(ReasoningPreviewContext)
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!isPreview) return
    const scrollEl = scrollRef.current
    const contentEl = contentRef.current
    if (!scrollEl || !contentEl) return

    let pinned = true
    let lastScrollTop = scrollEl.scrollTop
    let lastScrollHeight = scrollEl.scrollHeight
    const isAtBottom = () =>
      Math.abs(
        scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight
      ) <= 1 || scrollEl.scrollHeight <= scrollEl.clientHeight

    const pin = () => {
      if (!pinned) return
      scrollEl.scrollTop = scrollEl.scrollHeight
    }
    // A pin's own scroll event can arrive after new content grew the scroll
    // height and read as "not at bottom"; only an upward move at unchanged
    // scroll height is user intent.
    const onScroll = () => {
      if (isAtBottom()) {
        pinned = true
      } else if (
        scrollEl.scrollTop < lastScrollTop &&
        scrollEl.scrollHeight === lastScrollHeight
      ) {
        pinned = false
      }
      lastScrollTop = scrollEl.scrollTop
      lastScrollHeight = scrollEl.scrollHeight
    }

    pin()
    scrollEl.addEventListener("scroll", onScroll)
    const observer = new ResizeObserver(pin)
    observer.observe(contentEl)
    return () => {
      scrollEl.removeEventListener("scroll", onScroll)
      observer.disconnect()
    }
  }, [isPreview])

  return (
    <div
      ref={scrollRef}
      data-slot="reasoning-text"
      className={cn(
        "aui-reasoning-text relative z-0 max-h-64 overflow-y-auto text-pretty ps-6 pt-2 pb-2 leading-relaxed",
        "transform-gpu transition-[transform,opacity] ease-[cubic-bezier(0.32,0.72,0,1)]",
        "motion-reduce:animate-none",
        "group-data-open/collapsible-content:animate-in",
        "group-data-closed/collapsible-content:animate-out",
        "group-data-open/collapsible-content:fade-in-0",
        "group-data-closed/collapsible-content:fade-out-0",
        "group-data-open/collapsible-content:slide-in-from-top-4",
        "group-data-closed/collapsible-content:slide-out-to-top-4",
        "group-data-open/collapsible-content:blur-in-[2px]",
        "group-data-closed/collapsible-content:blur-out-[2px]",
        "group-data-open/collapsible-content:animation-duration-(--animation-duration)",
        "group-data-closed/collapsible-content:animation-duration-(--animation-duration)",
        className
      )}
      {...props}
    >
      <div ref={contentRef} className="aui-reasoning-text-content space-y-4">
        {children}
      </div>
    </div>
  )
}

const ReasoningImpl: ReasoningMessagePartComponent = () => <MarkdownText />

/** One reasoning part. The group below is what renders a run of them. */
const Reasoning = memo(ReasoningImpl) as ReasoningMessagePartComponent
Reasoning.displayName = "Reasoning"

/**
 * A consecutive run of reasoning parts, as one disclosure. This is the shape
 * `Thread`'s `ReasoningGroup` slot passes, so the composition lives here rather
 * than inline in the thread, and nothing else has to import the four pieces.
 */
const ReasoningGroup: FC<PropsWithChildren<{ group: ThreadGroupPart }>> = ({
  group,
  children,
}) => {
  const running = group.status.type === "running"
  return (
    <ReasoningRoot streaming={running}>
      <ReasoningTrigger active={running} />
      <ReasoningContent aria-busy={running}>
        <ReasoningText>{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  )
}
ReasoningGroup.displayName = "ReasoningGroup"

export { Reasoning, ReasoningGroup }
