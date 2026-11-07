import { cn } from "@workspace/ui/lib/utils"
import {
  type ComponentProps,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"

/** How far in from a clipped edge a chip fades out, in pixels (2rem). */
const FADE = 32

/**
 * Chips on one line. When they overflow, the row scrolls sideways with no
 * visible bar and each clipped edge fades, so nothing shows on the leading
 * edge until the row has been scrolled past it. Tab walks the chips, and a
 * focused chip is brought clear of both fades.
 *
 * After assistant-ui's `ThreadFollowupSuggestions` (elements registry, MIT).
 */
export function ChipRow({
  children,
  className,
  ...props
}: ComponentProps<"div">) {
  const scroller = useRef<HTMLDivElement>(null)
  const [fades, setFades] = useState({ start: false, end: false })

  const read = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const behind = el.scrollLeft
    const ahead = el.scrollWidth - el.clientWidth - behind
    setFades((now) => {
      const next = { start: behind > 1, end: ahead > 1 }
      return now.start === next.start && now.end === next.end ? now : next
    })
  }, [])

  useEffect(() => {
    read()
    const el = scroller.current
    if (!el) return
    // The browser leaves a chip that is partly in view where it is, which can
    // be a sliver under the fade.
    const clear = (event: FocusEvent) => {
      const row = el.getBoundingClientRect()
      const chip = (event.target as HTMLElement).getBoundingClientRect()
      const behind = chip.left - (row.left + FADE)
      const ahead = chip.right - (row.right - FADE)
      if (behind < 0) el.scrollBy({ left: behind })
      else if (ahead > 0) el.scrollBy({ left: ahead })
    }
    el.addEventListener("focusin", clear)
    const watch =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(read)
    watch?.observe(el)
    if (el.firstElementChild) watch?.observe(el.firstElementChild)
    return () => {
      el.removeEventListener("focusin", clear)
      watch?.disconnect()
    }
  }, [read])

  return (
    <div
      className={cn(
        // overflow-x clips both axes: the vertical padding, taken back by the
        // negative margin, leaves a focus ring room without moving the row.
        "data-fade-end:mask-r-from-[calc(100%-2rem)] data-fade-start:mask-l-from-[calc(100%-2rem)] -my-1 w-full overflow-x-auto py-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className
      )}
      data-fade-end={fades.end || undefined}
      data-fade-start={fades.start || undefined}
      data-slot="chip-row"
      onScroll={read}
      ref={scroller}
      {...props}
    >
      <div className="flex min-h-8 w-max items-center gap-2 px-0.5">
        {children}
      </div>
    </div>
  )
}
