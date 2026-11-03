import { Button } from "@workspace/ui/components/button"
import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps, ReactNode } from "react"

/**
 * A quick reply above the composer: one tap sends it, and the owner's
 * message reads its label word for word.
 */
export function ReplyPill({
  className,
  ...props
}: ComponentProps<typeof Button>) {
  return (
    <Button
      className={cn(
        "rounded-full text-muted-foreground aria-pressed:border-foreground aria-pressed:text-foreground",
        className
      )}
      size="sm"
      type="button"
      variant="outline"
      {...props}
    />
  )
}

/** A row of quick replies, named for a screen reader by the question they answer. */
export function ReplyPills({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <fieldset className="flex min-w-0 flex-wrap gap-2" data-slot="reply-pills">
      <legend className="sr-only">{label}</legend>
      {children}
    </fieldset>
  )
}

/**
 * Whether answers are quick replies rather than a card: two to four, each
 * short enough to read at a glance. Answers that need a picture stay tiles.
 */
export const isQuick = (labels: readonly string[]) =>
  labels.length >= 2 &&
  labels.length <= 4 &&
  labels.every((label) => label.length <= 32)
