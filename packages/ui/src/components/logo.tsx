import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps } from "react"

/**
 * The mark: a lowercase r with a full stop after it, a reply that has been
 * sent. It is the same drawing as the favicon.
 *
 * Everything is `currentColor`, so the mark takes the colour of whatever it sits
 * in and both themes are one drawing rather than two. The arm is a stroke and
 * the stop is a fill, so their weights stay independent at 16px.
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
      <path
        d="M7.5 18.5V11A4.5 4.5 0 0 1 12 6.5h2.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="3.4"
      />
      <circle cx="16.4" cy="16.6" fill="currentColor" r="2.3" />
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
        "inline-flex items-center gap-2.5 font-semibold text-lg tracking-tight",
        className
      )}
      {...props}
    >
      {/* On a tile, the same drawing as the favicon, so the tab and the page
          show one mark. */}
      <span className="inline-grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground">
        <LogoMark className={cn("size-4.5", markClassName)} />
      </span>
      Reme
    </span>
  )
}

export { Logo, LogoMark }
