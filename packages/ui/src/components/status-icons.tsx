import { HammerIcon } from "@phosphor-icons/react"
import { cn } from "@workspace/ui/lib/utils"
import type { ReactNode } from "react"

/**
 * Drawn icons for work the phosphor set has no moving picture of: each moves
 * its own parts while `animated`, in currentColor at the size its class
 * gives, and holds still under reduced motion. Keyframes are in globals.css.
 */
type DrawnIconProps = { className?: string; animated?: boolean }

function Svg({
  className,
  children,
}: {
  className?: string | undefined
  children: ReactNode
}) {
  return (
    <svg
      aria-hidden
      className={cn("size-4 shrink-0", className)}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.75}
      viewBox="0 0 24 24"
    >
      {children}
    </svg>
  )
}

/** A part that moves only while the icon does. */
const moving = (animated: boolean | undefined, motion: string) =>
  animated ? cn(motion, "motion-reduce:animate-none") : undefined

/** Six teeth as a dashed ring around a hub, for a gear at any radius. */
function Gear({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  const tooth = (2 * Math.PI * (r + 1.2)) / 6
  return (
    <>
      <circle cx={cx} cy={cy} r={r} />
      <circle
        cx={cx}
        cy={cy}
        r={r + 1.2}
        strokeDasharray={`${tooth * 0.45} ${tooth * 0.55}`}
        strokeLinecap="butt"
        strokeWidth={2.2}
      />
    </>
  )
}

/** Setting up: a turning gear inside a ring, half drawn and half to come. */
export function SetupIcon({ className, animated }: DrawnIconProps) {
  return (
    <Svg className={className}>
      <path d="M12 2.5a9.5 9.5 0 0 0 0 19" />
      <path
        className={moving(animated, "animate-icon-dash")}
        d="M12 2.5a9.5 9.5 0 0 1 0 19"
        strokeDasharray="1.4 2.3"
        strokeLinecap="butt"
      />
      <g
        className={cn(
          "origin-center [transform-box:fill-box]",
          moving(animated, "animate-icon-spin")
        )}
      >
        <Gear cx={12} cy={12} r={3.3} />
      </g>
    </Svg>
  )
}

/** A question waiting on the owner: a question mark that rocks, its dot blinking. */
export function QuestionIcon({ className, animated }: DrawnIconProps) {
  return (
    <Svg className={className}>
      <circle cx={12} cy={12} r={9.5} />
      <g
        className={moving(animated, "animate-icon-rock")}
        style={{ transformOrigin: "12px 16px" }}
      >
        <path d="M9.4 9.4a2.7 2.7 0 1 1 3.9 2.4c-.8.4-1.3 1-1.3 1.9v.3" />
      </g>
      <circle
        className={moving(animated, "animate-icon-blink")}
        cx={12}
        cy={17}
        fill="currentColor"
        r={0.6}
        stroke="none"
      />
    </Svg>
  )
}

/** Waiting on the owner: a speech bubble whose three dots rise in turn, like someone about to reply. */
export function WaitingIcon({ className, animated }: DrawnIconProps) {
  return (
    <Svg className={className}>
      <path d="M7.49 19.79A9 9 0 1 0 4.21 16.51L3.04 20.01a.75.75 0 0 0 .95.95z" />
      {[8, 12, 16].map((cx, i) => (
        <circle
          className={moving(animated, "animate-icon-typing")}
          cx={cx}
          cy={12}
          fill="currentColor"
          key={cx}
          r={1.1}
          stroke="none"
          style={animated ? { animationDelay: `${i * 0.2}s` } : undefined}
        />
      ))}
    </Svg>
  )
}

/** Planning: a clipboard whose three ticks are checked off in turn. */
export function PlanningIcon({ className, animated }: DrawnIconProps) {
  const rows = [9.5, 13.5, 17.5]
  return (
    <Svg className={className}>
      <rect height={17} rx={2} width={14} x={5} y={4} />
      <rect height={3} rx={1} width={6} x={9} y={2.5} />
      {rows.map((y, i) => (
        <g key={y}>
          <path
            className={moving(animated, "animate-icon-draw")}
            d={`M7.6 ${y - 0.2}l1.5 1.5 2.5-3`}
            pathLength={1}
            strokeDasharray={1}
            style={animated ? { animationDelay: `${i * 0.35}s` } : undefined}
          />
          <path d={`M13.5 ${y}h2.5`} />
        </g>
      ))}
    </Svg>
  )
}

/** Making photos: a picture, its sun rising, a sparkle where it is made. */
export function PhotosIcon({ className, animated }: DrawnIconProps) {
  return (
    <Svg className={className}>
      <path d="M14 3.5H5.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2V10" />
      <path d="m3.5 17 5-5 4 4 2.5-2.5 5.5 5.5" />
      <circle
        className={moving(animated, "animate-icon-rise")}
        cx={9}
        cy={8.5}
        r={1.6}
      />
      <path
        className={cn(
          "origin-center [transform-box:fill-box]",
          moving(animated, "animate-icon-twinkle")
        )}
        d="M19 1.8v4.4M16.8 4h4.4"
      />
    </Svg>
  )
}

/** Writing the pages: lines written one after another, the pen moving along. */
export function WritingIcon({ className, animated }: DrawnIconProps) {
  const lines = [
    { y: 6, to: 14 },
    { y: 11, to: 12 },
    { y: 16, to: 9 },
  ]
  return (
    <Svg className={className}>
      {lines.map(({ y, to }, i) => (
        <path
          className={moving(animated, "animate-icon-write-line")}
          d={`M3.5 ${y}H${to}`}
          key={y}
          pathLength={1}
          strokeDasharray={1}
          style={animated ? { animationDelay: `${i * 0.4}s` } : undefined}
        />
      ))}
      <g className={moving(animated, "animate-icon-pen")}>
        <path d="m15.5 19.5 5.6-5.6a1.4 1.4 0 0 0-2-2l-5.6 5.6-.6 2.6z" />
      </g>
    </Svg>
  )
}

/** Polishing: a brush sweeping back and forth, a glint where it passed. */
export function PolishingIcon({ className, animated }: DrawnIconProps) {
  return (
    <Svg className={className}>
      <g
        className={moving(animated, "animate-icon-brush")}
        style={{ transformOrigin: "20px 4px" }}
      >
        <path d="m20 4-6.2 6.2" />
        <path d="m12.3 9.7 2 2" />
        <path d="M12.3 9.7 9 13c-.9.9-1.2 2.3-1.6 3.7-.3 1-1 1.7-2.4 2 2.6.6 5.2.1 6.6-1.3l2.7-3.4" />
      </g>
      <path
        className={cn(
          "origin-center [transform-box:fill-box]",
          moving(animated, "animate-icon-twinkle")
        )}
        d="M5 4v4M3 6h4"
        style={animated ? { animationDelay: "0.6s" } : undefined}
      />
    </Svg>
  )
}

/** Building the website: a hammer tapping beside a turning gear. */
export function BuildingIcon({ className, animated }: DrawnIconProps) {
  return (
    <Svg className={className}>
      <g
        className={moving(animated, "animate-icon-hammer")}
        stroke="none"
        style={{ transformOrigin: "5px 13px" }}
      >
        <HammerIcon height={16} width={16} x={0} y={0} />
      </g>
      <g
        className={cn(
          "origin-center [transform-box:fill-box]",
          moving(animated, "animate-icon-spin")
        )}
      >
        <Gear cx={17} cy={17} r={2.1} />
      </g>
    </Svg>
  )
}

/** Reading a message: a speech bubble whose lines light up one after another. */
export function ReadingIcon({ className, animated }: DrawnIconProps) {
  const lines = [
    { y: 7.5, to: 16.5 },
    { y: 10.5, to: 16.5 },
    { y: 13.5, to: 12.5 },
  ]
  return (
    <Svg className={className}>
      <path d="M6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5v-8A2.5 2.5 0 0 1 6.5 3z" />
      {lines.map(({ y, to }, i) => (
        <path
          className={moving(animated, "animate-icon-blink")}
          d={`M7.5 ${y}H${to}`}
          key={y}
          style={animated ? { animationDelay: `${i * 0.3}s` } : undefined}
        />
      ))}
    </Svg>
  )
}

/** Thinking: a sparkle that turns and breathes, a small one glinting beside it. */
export function ThinkingIcon({ className, animated }: DrawnIconProps) {
  return (
    <Svg className={className}>
      <path
        className={cn(
          "origin-center [transform-box:fill-box]",
          moving(animated, "animate-icon-breathe")
        )}
        d="M11 4.5Q12 11 18.5 12Q12 13 11 19.5Q10 13 3.5 12Q10 11 11 4.5Z"
      />
      <path
        className={cn(
          "origin-center [transform-box:fill-box]",
          moving(animated, "animate-icon-twinkle")
        )}
        d="M19 2.5v4M17 4.5h4"
        style={animated ? { animationDelay: "0.5s" } : undefined}
      />
    </Svg>
  )
}
