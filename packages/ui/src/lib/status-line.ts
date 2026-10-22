/**
 * The timing rules of a status line, kept apart from React so they read, and
 * test, as plain numbers.
 */

/** A working line shows only after this long, so a fast tool never flashes. */
export const SHOW_DELAY_MS = 300

/** Once a working line shows, its words stay at least this long. */
export const MIN_SHOWN_MS = 2000

/** In chat the elapsed time appears after this long; the panel shows it at once. */
export const CLOCK_AFTER_MS = 15_000

export type StatusState = "working" | "waiting" | "done" | "failed" | "stopped"

/**
 * How long a line that is showing must keep its words before `next` replaces
 * them. A working line is held to `MIN_SHOWN_MS`; anything the owner needs
 * to see now (a failure, a wait on them) replaces it at once, as does a line
 * that was not working.
 */
export function holdFor(
  shown: StatusState,
  next: StatusState,
  shownAt: number,
  now: number
): number {
  if (shown !== "working" || next === "failed" || next === "waiting") return 0
  return Math.max(0, shownAt + MIN_SHOWN_MS - now)
}

/** Identical lines in a row fold into one with a count: Hermes' `x3`. */
export function foldLines(
  lines: readonly string[]
): { label: string; count: number }[] {
  const folded: { label: string; count: number }[] = []
  for (const label of lines) {
    const last = folded.at(-1)
    if (last?.label === label) last.count += 1
    else folded.push({ label, count: 1 })
  }
  return folded
}
