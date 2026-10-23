import {
  BellIcon,
  CheckCircleIcon,
  CreditCardIcon,
  GlobeIcon,
  HourglassMediumIcon,
  MagnifyingGlassIcon,
  MinusCircleIcon,
  type Icon as PhosphorIcon,
  PlugsConnectedIcon,
  RocketLaunchIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react"
import {
  BuildingIcon,
  PhotosIcon,
  PlanningIcon,
  PolishingIcon,
  QuestionIcon,
  ReadingIcon,
  SetupIcon,
  ThinkingIcon,
  WritingIcon,
} from "@workspace/ui/components/status-icons"
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
 * What the assistant is doing, in one line: a small mark that moves while
 * the work runs, a breathing dot while it reads and three dots folding
 * through a wave and a triangle after, then a few words with a soft light
 * sweeping across them, wiped in from the left as they change. Chat and
 * panel draw it the same way.
 *
 * The mark sits beside the words, not in them: the shimmer masks everything
 * inside its host. Motion is on the mark and the words only while the state
 * is `working`, and both hold still under reduced motion.
 */

/**
 * One icon per kind of work, each with its own small motion (globals.css),
 * keyed by the copy table's kinds so a line and its icon come from one place.
 */
const KINDS: Record<
  StatusKind,
  { Icon: PhosphorIcon; motion: string } | { Drawn: typeof SetupIcon }
> = {
  reading: { Drawn: ReadingIcon },
  thinking: { Drawn: ThinkingIcon },
  still: { Icon: HourglassMediumIcon, motion: "animate-status-turn" },
  setup: { Drawn: SetupIcon },
  question: { Drawn: QuestionIcon },
  planning: { Drawn: PlanningIcon },
  building: { Drawn: BuildingIcon },
  photos: { Drawn: PhotosIcon },
  writing: { Drawn: WritingIcon },
  polishing: { Drawn: PolishingIcon },
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
  return <KindIcon className={className} kind={kind} moving={!still} />
}

/** A kind's icon, drawn or from phosphor, moving while `moving`. */
function KindIcon({
  kind,
  moving,
  className,
}: {
  kind: StatusKind
  moving: boolean
  className?: string | undefined
}) {
  const entry = KINDS[kind]
  if ("Drawn" in entry) {
    return <entry.Drawn animated={moving} className={className} />
  }
  const { Icon, motion } = entry
  return (
    <Icon
      aria-hidden
      className={cn(
        "size-4 shrink-0 motion-reduce:animate-none",
        moving && motion,
        className
      )}
    />
  )
}

/** The reading dot. */
function BreathingDot() {
  return (
    <span
      aria-hidden
      className="flex size-4 shrink-0 items-center justify-center"
    >
      <span className="size-2 rounded-full bg-current motion-safe:animate-status-breathe" />
    </span>
  )
}

const CYCLE_MS = 3200
const SPREAD = 4.6
const RADIUS = 4.4
const ease = (k: number) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2)

/** The dots in a line, a wave running through them. */
const wave = (ms: number) =>
  [0, 1, 2].map((dot) => ({
    x: (dot - 1) * SPREAD,
    y: 2 * Math.sin((ms / 700) * 2 * Math.PI - dot * 0.9),
  }))

/** The dots as a turning triangle that draws in to its centre and out, twice. */
const triangle = (ms: number) => {
  const r = 1 + (RADIUS - 1) * (0.5 + 0.5 * Math.cos((ms / 600) * 2 * Math.PI))
  return [0, 1, 2].map((dot) => {
    const a = (ms / 2400) * 2 * Math.PI + (dot * 2 * Math.PI) / 3 + Math.PI
    return { x: r * Math.cos(a), y: r * Math.sin(a) }
  })
}

const between = (
  from: { x: number; y: number }[],
  to: { x: number; y: number }[],
  k: number
) =>
  from.map((p, dot) => ({
    x: p.x + ((to[dot]?.x ?? p.x) - p.x) * ease(k),
    y: p.y + ((to[dot]?.y ?? p.y) - p.y) * ease(k),
  }))

/** Where the dots are `ms` into a cycle: wave, fold, triangle, unfold. */
function dotsAt(ms: number) {
  if (ms < 1400) return wave(ms)
  if (ms < 1700) return between(wave(1400), triangle(0), (ms - 1400) / 300)
  if (ms < 2900) return triangle(ms - 1700)
  return between(triangle(1200), wave(0), (ms - 2900) / 300)
}

/** The working mark: three dots, moved by the frame, still under reduced motion. */
function FoldingDots() {
  const dots = useRef<(SVGCircleElement | null)[]>([])
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const start = performance.now()
    let frame = requestAnimationFrame(function draw(now) {
      dotsAt((now - start) % CYCLE_MS).forEach((p, dot) => {
        dots.current[dot]?.setAttribute("cx", p.x.toFixed(2))
        dots.current[dot]?.setAttribute("cy", p.y.toFixed(2))
      })
      frame = requestAnimationFrame(draw)
    })
    return () => cancelAnimationFrame(frame)
  }, [])
  return (
    <svg
      aria-hidden
      className="size-4 shrink-0"
      fill="currentColor"
      viewBox="-8 -8 16 16"
    >
      {wave(0).map((p, dot) => (
        <circle
          cx={p.x}
          cy={p.y}
          // biome-ignore lint/suspicious/noArrayIndexKey: three fixed dots
          key={dot}
          r="1.5"
          ref={(node) => {
            dots.current[dot] = node
          }}
        />
      ))}
    </svg>
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
            : null
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
      {Icon ? (
        <Icon
          aria-hidden
          className={cn(
            "size-4 shrink-0",
            shown.state === "done" && "text-primary",
            shown.state === "failed" && "text-destructive"
          )}
          weight={shown.state === "done" ? "fill" : "regular"}
        />
      ) : shown.kind === "reading" ? (
        <BreathingDot />
      ) : (
        <FoldingDots />
      )}
      {/* The words alone: the live region never reads the clock or the count. */}
      <span
        aria-live={announce ? "polite" : undefined}
        className="inline-block"
        data-slot="status-line-text"
        role={announce ? "status" : undefined}
      >
        {/* The wipe holds its own mask, outside the one the shimmer sets. */}
        <span
          className="inline-block motion-safe:animate-status-reveal"
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
