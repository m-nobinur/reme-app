import { cn } from "@workspace/ui/lib/utils"
import { type ReactNode, useId } from "react"

/**
 * Something still being made: its colours as soft light under a grain,
 * drifting and sharpening while it waits; still under reduced motion.
 * `children` sit on top, centred, for a line that says why it waits.
 */
export function Diffusing({
  colors,
  paper,
  delay = 0,
  motion = "motion-safe:animate-logo-diffuse",
  className,
  children,
}: {
  colors: readonly string[]
  paper: string
  delay?: number
  /** How the light moves: the logo's drift and sharpen, or another loop. */
  motion?: string
  /** Its shape and size: the tile it holds the place of. */
  className?: string
  children?: ReactNode
}) {
  const id = useId()
  const [first = paper, second = first] = colors
  return (
    <span
      className={cn("relative block overflow-hidden", className)}
      data-slot="diffusing"
      style={{ backgroundColor: paper }}
    >
      <span
        aria-hidden
        className={cn("absolute -inset-1/4 opacity-60 blur-xl", motion)}
        style={{
          animationDelay: `${-delay}ms`,
          backgroundImage: `radial-gradient(circle at 35% 35%, ${first}, transparent 55%), radial-gradient(circle at 65% 70%, ${second}, transparent 55%)`,
        }}
      />
      <svg
        aria-hidden
        className="absolute inset-0 size-full opacity-30 mix-blend-multiply"
        role="presentation"
      >
        <filter id={id}>
          <feTurbulence
            baseFrequency="0.85"
            numOctaves="2"
            stitchTiles="stitch"
            type="fractalNoise"
          />
        </filter>
        <rect filter={`url(#${id})`} height="100%" width="100%" />
      </svg>
      {children ? (
        <span className="absolute inset-0 grid place-items-center p-3 text-center">
          {children}
        </span>
      ) : null}
    </span>
  )
}
