import { type RefObject, useEffect, useRef } from "react"

/** The step a segment is at: working on it, or waiting on the owner. */
const CURRENT = 'li[data-state="now"], li[data-state="waiting"]'

/** The nearest ancestor that scrolls, which is the panel's body. */
function scrollerOf(row: HTMLElement): HTMLElement | null {
  for (let at = row.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at)
    if (overflowY === "auto" || overflowY === "scroll") return at
  }
  return null
}

/**
 * Whether any of a row shows in its scroller. Any, not all: the step that
 * just finished may have grown a result under it, which pushes its bottom
 * edge out without the owner having scrolled.
 */
const shows = (row: DOMRect, box: DOMRect) =>
  row.bottom > box.top && row.top < box.bottom

/**
 * Brings the panel's current step into view when it moves on, but only if
 * the step it left was in view: an owner who scrolled elsewhere to read keeps
 * their place. Returns the current row, to be passed back next time. Does
 * not scroll when nothing came before, or when the panel is hidden, where
 * every box is empty.
 */
export function followStep(
  root: HTMLElement,
  before: HTMLElement | null,
  reduced: boolean
): HTMLElement | null {
  const row = root.querySelector<HTMLElement>(CURRENT)
  if (!row || row === before) return row
  const box = before && scrollerOf(row)?.getBoundingClientRect()
  if (before && box && shows(before.getBoundingClientRect(), box)) {
    row.scrollIntoView({
      block: "nearest",
      behavior: reduced ? "auto" : "smooth",
    })
  }
  return row
}

/** `followStep` after every render of the panel, which is when a step can move. */
export function useFollowStep(root: RefObject<HTMLElement | null>) {
  const row = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (!root.current) return
    row.current = followStep(
      root.current,
      row.current,
      matchMedia("(prefers-reduced-motion: reduce)").matches
    )
  })
}
