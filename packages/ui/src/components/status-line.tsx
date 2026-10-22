import {
  BellIcon,
  CheckCircleIcon,
  CirclesFourIcon,
  CreditCardIcon,
  GlobeIcon,
  HammerIcon,
  HourglassMediumIcon,
  ImageSquareIcon,
  ListBulletsIcon,
  MagnifyingGlassIcon,
  MinusCircleIcon,
  type Icon as PhosphorIcon,
  PlugsConnectedIcon,
  RocketLaunchIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react"
import {
  type StatusKind,
  type ToolArgs,
  toolKind,
  toolLine,
} from "@workspace/ui/lib/activity-copy"
import { duration } from "@workspace/ui/lib/format"
import {
  CLOCK_AFTER_MS,
  holdFor,
  SHOW_DELAY_MS,
  type StatusState,
} from "@workspace/ui/lib/status-line"
import { cn } from "@workspace/ui/lib/utils"
import { type ComponentProps, useEffect, useRef, useState } from "react"

/**
 * What the assistant is doing, in one line: an icon that moves while the work
 * runs, then a few words with the brand colour sweeping across them. Chat and
 * panel draw it the same way.
 *
 * The icon sits beside the words, not in them: the shimmer masks everything
 * inside its host. Motion is on the icon and the words only while the state
 * is `working`, and both hold still under reduced motion.
 */

/**
 * One icon per kind of work, each with its own small motion (globals.css),
 * keyed by the copy table's kinds so a line and its icon come from one place.
 */
const KINDS: Record<StatusKind, { Icon: PhosphorIcon; motion: string }> = {
  thinking: { Icon: ListBulletsIcon, motion: "animate-status-steps" },
  planning: { Icon: CirclesFourIcon, motion: "animate-status-pulse" },
  building: {
    Icon: HammerIcon,
    motion: "origin-bottom-right animate-status-tap",
  },
  photos: { Icon: ImageSquareIcon, motion: "animate-status-fade" },
  checking: { Icon: MagnifyingGlassIcon, motion: "animate-status-sweep" },
  domain: { Icon: GlobeIcon, motion: "animate-status-turn" },
  google: { Icon: PlugsConnectedIcon, motion: "animate-status-meet" },
  reminder: { Icon: BellIcon, motion: "origin-top animate-status-swing" },
  payment: { Icon: CreditCardIcon, motion: "animate-status-fade" },
  publishing: { Icon: RocketLaunchIcon, motion: "animate-status-lift" },
  waiting: { Icon: HourglassMediumIcon, motion: "" },
}

/**
 * The icon for a kind of work, for a row that draws its own words (the
 * panel's steps and segment headers). It moves unless `still`.
 */
export function StatusIcon({
  kind,
  still = false,
  className,
}: {
  kind: StatusKind
  still?: boolean
  className?: string
}) {
  const { Icon, motion } = KINDS[kind]
  return (
    <Icon
      aria-hidden
      className={cn(
        "size-4 shrink-0 motion-reduce:animate-none",
        !still && motion,
        className
      )}
    />
  )
}

type Line = { kind: StatusKind; state: StatusState; label: string }

/**
 * The line to draw now. A working line waits `delay` before it shows, so a
 * tool that finishes sooner never flashes, and once shown it keeps its words
 * for the minimum before a quieter line replaces them. A failure or a wait on
 * the owner replaces it at once.
 */
function useSettled(next: Line, delay: number): Line | null {
  const [shown, setShown] = useState<Line | null>(
    next.state === "working" && delay > 0 ? null : next
  )
  const shownAt = useRef(Date.now())
  const { kind, state, label } = next
  useEffect(() => {
    if (
      shown?.kind === kind &&
      shown.state === state &&
      shown.label === label
    ) {
      return
    }
    const wait = shown
      ? holdFor(shown.state, state, shownAt.current, Date.now())
      : state === "working"
        ? delay
        : 0
    const show = () => {
      shownAt.current = Date.now()
      setShown({ kind, state, label })
    }
    if (wait <= 0) {
      show()
      return
    }
    const timer = setTimeout(show, wait)
    return () => clearTimeout(timer)
  }, [kind, state, label, delay, shown])
  return shown
}

/** Milliseconds since `since` (or since this ran), ticking while `active`. */
function useClock(active: boolean, since: number | undefined) {
  const [now, setNow] = useState<number | null>(null)
  const began = useRef(0)
  useEffect(() => {
    if (!active) return
    began.current = since ?? Date.now()
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active, since])
  return active && now !== null ? now - began.current : null
}

function StatusLine({
  kind,
  state = "working",
  label,
  count = 1,
  since,
  clockAfter = CLOCK_AFTER_MS,
  elapsed,
  delay = SHOW_DELAY_MS,
  announce = true,
  className,
  ...props
}: Omit<ComponentProps<"span">, "children"> & {
  kind: StatusKind
  state?: StatusState
  /** The words, from the copy table: present tense while working. */
  label: string
  /** How many identical lines this stands for (`foldLines`). */
  count?: number
  /** When the work began, in ms; else when the line first showed. */
  since?: number
  /** The clock appears after this many ms; `null` never shows one. */
  clockAfter?: number | null
  /** Pins the clock to this many ms, for the catalog. */
  elapsed?: number
  /** Ms before a working line shows. A control that must always be there passes 0. */
  delay?: number
  /** Say the line in a polite live region. One per surface: the rest pass false. */
  announce?: boolean
}) {
  const shown = useSettled({ kind, state, label }, delay)
  const active = shown?.state === "working" || shown?.state === "waiting"
  const ticking = useClock(active && elapsed === undefined, since)
  if (!shown) return null

  const clock = elapsed ?? ticking
  const working = shown.state === "working"
  const Icon =
    shown.state === "done"
      ? CheckCircleIcon
      : shown.state === "failed"
        ? WarningCircleIcon
        : shown.state === "waiting"
          ? HourglassMediumIcon
          : shown.state === "stopped"
            ? MinusCircleIcon
            : KINDS[shown.kind].Icon
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 text-muted-foreground",
        className
      )}
      data-slot="status-line"
      data-state={shown.state}
      {...props}
    >
      <Icon
        aria-hidden
        className={cn(
          "size-4 shrink-0 motion-reduce:animate-none",
          working && KINDS[shown.kind].motion,
          shown.state === "done" && "text-primary",
          shown.state === "failed" && "text-destructive"
        )}
        weight={shown.state === "done" ? "fill" : "regular"}
      />
      {/* The words alone: the live region never reads the clock or the count. */}
      <span
        aria-live={announce ? "polite" : undefined}
        className={cn(
          "inline-block",
          working && "shimmer shimmer-color-primary motion-reduce:animate-none"
        )}
        data-slot="status-line-text"
        role={announce ? "status" : undefined}
      >
        {shown.label}
      </span>
      {count > 1 ? <span className="tabular-nums">×{count}</span> : null}
      {clock !== null && clockAfter !== null && clock >= clockAfter ? (
        <span className="text-xs tabular-nums">{duration(clock)}</span>
      ) : null}
    </span>
  )
}

/**
 * A tool's line in the thread, in the copy table's words and icon for that
 * tool. A tool outside the table reads "Working on it", never its name.
 */
function ToolStatus({
  tool,
  args,
  state,
  ...props
}: Omit<ComponentProps<typeof StatusLine>, "kind" | "label" | "state"> & {
  tool: string
  args?: ToolArgs
  state: StatusState
}) {
  return (
    <StatusLine
      kind={toolKind(tool)}
      // A tool waiting on the owner still says what it is doing.
      label={toolLine(tool, state === "waiting" ? "working" : state, args)}
      state={state}
      {...props}
    />
  )
}

export type { StatusKind }
export { StatusLine, ToolStatus }
