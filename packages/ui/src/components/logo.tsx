import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps } from "react"

/**
 * The mark, drawn as the shape the product is about.
 *
 * Reme is one point of contact with a workforce behind it: the owner talks to
 * the Chief of Staff, and the Chief of Staff delegates. That is the org tree on
 * /app/staff, and it is this glyph — one filled node with a stem dropping to two
 * beneath it. It is deliberately the same figure a person meets twice, once here
 * and once as their own staff list.
 *
 * Everything is `currentColor`, so the mark takes the colour of whatever it sits
 * in and both themes are one drawing rather than two. The stem is a stroke and
 * the nodes are fills, which keeps the weights independent: at 16px the stem
 * would disappear if it scaled with the radii.
 */
function LogoMark({ className, ...props }: ComponentProps<"svg">) {
  return (
    <svg
      aria-hidden
      className={cn("size-6", className)}
      fill="none"
      focusable="false"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {/* Down from the lead node to the rail, then down to each report. One
          path, so the corners stay joined at any size. */}
      <path d="M12 7.5V10.5" stroke="currentColor" strokeWidth="1.75" />
      <path
        d="M6 14V12a1.5 1.5 0 0 1 1.5-1.5h9A1.5 1.5 0 0 1 18 12v2"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      {/* Hierarchy by size rather than by opacity: a faded node reads as
          disabled, and at 20px it reads as smudged. */}
      <circle cx="12" cy="4.5" fill="currentColor" r="3" />
      <circle cx="6" cy="16.5" fill="currentColor" r="2.5" />
      <circle cx="18" cy="16.5" fill="currentColor" r="2.5" />
    </svg>
  )
}

/**
 * The mark and the name, which is what goes at the top of every page in the
 * sign-in flow and anywhere else the product has to say who it is.
 *
 * `title` is a real element rather than an aria-label so the name is selectable
 * text: it is a wordmark, not an image of one, and a person who zooms to 400%
 * gets type that reflows instead of a bitmap.
 */
function Logo({
  className,
  markClassName,
  ...props
}: ComponentProps<"span"> & { markClassName?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 font-semibold text-base tracking-tight",
        className
      )}
      {...props}
    >
      <LogoMark className={cn("size-5 text-primary", markClassName)} />
      Reme
    </span>
  )
}

export { Logo, LogoMark }
