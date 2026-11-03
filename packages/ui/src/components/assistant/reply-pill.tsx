import { Button } from "@workspace/ui/components/button"
import { composerIdle } from "@workspace/ui/hooks/use-reveal-waiting"
import { cn } from "@workspace/ui/lib/utils"
import {
  type ComponentProps,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"

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

/**
 * Whether the reply above has finished typing in: its Markdown reads
 * `data-status="running"` until the reveal catches up, which can be after
 * the stream itself ends. Null outside a thread, with nothing to wait for.
 */
export function useWordsIn(ref: RefObject<HTMLElement | null>): boolean | null {
  const [words, setWords] = useState<boolean | null>(false)
  useLayoutEffect(() => {
    const thread = ref.current?.closest('[data-slot="aui_thread-viewport"]')
    if (!thread) return setWords(null)
    const read = () =>
      setWords(!thread.querySelector('.aui-md[data-status="running"]'))
    read()
    const observer = new MutationObserver(read)
    observer.observe(thread, {
      subtree: true,
      childList: true,
      attributeFilter: ["data-status"],
    })
    return () => observer.disconnect()
  }, [ref])
  return words
}

/** Quick replies wait for the words above, then fade in together. */
export const pillsIn = (words: boolean | null) =>
  words === false
    ? "invisible"
    : "motion-safe:fade-in duration-enter ease-standard motion-safe:animate-in"

/**
 * A row of quick replies, named for a screen reader by the question they
 * answer. It shows once the reply above has typed in, and takes the focus to
 * its first pill then, unless the owner is typing in the composer.
 */
export function ReplyPills({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  const ref = useRef<HTMLFieldSetElement>(null)
  const words = useWordsIn(ref)
  useEffect(() => {
    if (!words) return
    // A task on: the composer refocuses itself as a run ends.
    const timer = setTimeout(() => {
      if (!composerIdle()) return
      ref.current
        ?.querySelector<HTMLElement>("button:not(:disabled)")
        ?.focus({ preventScroll: true })
    })
    return () => clearTimeout(timer)
  }, [words])
  return (
    <fieldset
      className={cn("flex min-w-0 flex-wrap gap-2", pillsIn(words))}
      data-slot="reply-pills"
      ref={ref}
    >
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
