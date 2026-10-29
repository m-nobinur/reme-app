import {
  type CopyContext,
  type Phase,
  phaseState,
  STILL_AFTER,
  type StatusKind,
  type ToolArgs,
  toolLine,
} from "@workspace/ui/lib/activity-copy"
import { duration } from "@workspace/ui/lib/format"
import {
  KIND_MARKS,
  type Mark,
  STATE_MARKS,
  type StateName,
} from "@workspace/ui/lib/status-icons"
import {
  CLOCK_AFTER_MS,
  holdFor,
  SHOW_DELAY_MS,
  type StatusState,
} from "@workspace/ui/lib/status-line"
import { cn } from "@workspace/ui/lib/utils"
import { type ComponentProps, useEffect, useRef, useState } from "react"

/**
 * What the assistant is doing, in one line: the working dots while the work
 * runs, then a few words with a soft light sweeping across them, wiped in
 * from the left as they change; once it ends, the state's mark. Chat and
 * panel draw it the same way.
 *
 * The mark sits beside the words, not in them: the shimmer masks everything
 * inside its host. Motion is on the mark and the words only while the state
 * is `working`, and both hold still under reduced motion.
 */

/** A mark from the icon list, moving while `moving`. */
function MarkIcon({
  mark,
  moving,
  className,
}: {
  mark: Mark
  moving: boolean
  className?: string | undefined
}) {
  if ("Drawn" in mark) {
    return <mark.Drawn animated={moving} className={className} />
  }
  return (
    <mark.Icon
      aria-hidden
      className={cn(
        "size-4 shrink-0 motion-reduce:animate-none",
        moving && mark.motion,
        className
      )}
      weight={mark.weight}
    />
  )
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
  return (
    <MarkIcon className={className} mark={KIND_MARKS[kind]} moving={!still} />
  )
}

/** Where something stands, in the list's size and colour; `className` places it. */
export function StateIcon({
  state,
  className,
}: {
  state: StateName
  className?: string
}) {
  const mark = STATE_MARKS[state]
  return (
    <MarkIcon
      className={cn(mark.size, mark.colour, className)}
      mark={mark}
      moving={state === "working"}
    />
  )
}

/** Finished: the one done mark. */
export function DoneIcon({ className }: { className?: string }) {
  return <StateIcon className={className} state="done" />
}

type Line = { state: StatusState; label: string }

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
  const { state, label } = next
  useEffect(() => {
    if (shown?.state === state && shown.label === label) return
    const wait = shown
      ? holdFor(shown.state, state, shownAt.current, Date.now())
      : state === "working"
        ? delay
        : 0
    const show = () => {
      shownAt.current = Date.now()
      setShown({ state, label })
    }
    if (wait <= 0) {
      show()
      return
    }
    const timer = setTimeout(show, wait)
    return () => clearTimeout(timer)
  }, [state, label, delay, shown])
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
  const shown = useSettled({ state, label }, delay)
  // The words it mounted with: a line that loads finished, as a stored
  // message's does, arrives still, and only a change wipes in.
  const [first] = useState(label)
  const active = shown?.state === "working" || shown?.state === "waiting"
  const ticking = useClock(active && elapsed === undefined, since)
  if (!shown) return null

  const clock = elapsed ?? ticking
  const working = shown.state === "working"
  const reveal = working || shown.label !== first
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
      <StateIcon state={shown.state} />
      {/* The words alone: the live region never reads the clock or the count. */}
      <span
        aria-live={announce ? "polite" : undefined}
        className="inline-block"
        data-slot="status-line-text"
        role={announce ? "status" : undefined}
      >
        {/* The wipe holds its own mask, outside the one the shimmer sets. */}
        <span
          className={cn(
            "inline-block",
            reveal && "motion-safe:animate-status-reveal"
          )}
          key={shown.label}
        >
          <span
            className={cn(
              "inline-block",
              working &&
                "shimmer shimmer-color-foreground motion-reduce:animate-none"
            )}
          >
            {shown.label}
          </span>
        </span>
      </span>
      {count > 1 ? <span className="tabular-nums">×{count}</span> : null}
      {clock !== null && clockAfter !== null && clock >= clockAfter ? (
        <span className="text-xs tabular-nums">{duration(clock)}</span>
      ) : null}
    </span>
  )
}

/** True once `active` has held for `ms`, so a line that runs long can say so. */
function useLongerThan(active: boolean, ms: number) {
  const [over, setOver] = useState(false)
  useEffect(() => {
    setOver(false)
    if (!active) return
    const timer = setTimeout(() => setOver(true), ms)
    return () => clearTimeout(timer)
  }, [active, ms])
  return active && over
}

/**
 * A tool's line in the thread, in the copy table's words for that tool,
 * for its phase (`partPhase`). A working line that runs long says "Still".
 * A tool outside the table reads as its kind or "Working on it", never its
 * name. `copy` seeds the variant with the turn.
 */
function ToolStatus({
  tool,
  args,
  state,
  copy,
  ...props
}: Omit<ComponentProps<typeof StatusLine>, "label" | "state"> & {
  tool: string
  args?: ToolArgs
  state: Phase
  copy?: CopyContext
}) {
  const still = useLongerThan(state === "working", STILL_AFTER * 1000)
  const phase = still ? "still" : state
  return (
    <StatusLine
      label={toolLine(tool, phase, args, copy)}
      state={phaseState(phase)}
      {...props}
    />
  )
}

export type { StatusKind }
export { StatusLine, ToolStatus }
