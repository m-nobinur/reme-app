import { useAuiState } from "@assistant-ui/react"
import { ChipRow } from "@workspace/ui/components/assistant/chip-row"
import { Button } from "@workspace/ui/components/button"
import { useFocusWhenIdle } from "@workspace/ui/hooks/use-reveal-waiting"
import { cn } from "@workspace/ui/lib/utils"
import {
  type ComponentProps,
  createContext,
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"

/** How long a tapped pill takes to slide into the composer, and its row to fade. */
const INTO_COMPOSER_MS = 200

/** A tap on a pill in a row above the composer: the pill goes in, then `then` runs. */
type Into = (pill: HTMLElement, then: () => unknown) => void

const IntoComposer = createContext<Into | null>(null)

/** How many rows of quick replies the thread shows above its composer, and the way to count one. */
type Shown = { rows: number; set: Dispatch<SetStateAction<number>> }

const PillsShown = createContext<Shown | null>(null)

/** Lets a thread's rows of quick replies be counted, so what sits above its composer can make way for them. */
export const PillsShownProvider = PillsShown.Provider

/** Whether a row of quick replies is up in this thread, so the update stack gives way to it. */
export const usePillsShown = () => (useContext(PillsShown)?.rows ?? 0) > 0

/**
 * A quick reply: one tap sends it, and the owner's message reads its label
 * word for word. In a row above the composer it slides into the composer
 * first.
 */
export function ReplyPill({
  className,
  onClick,
  ...props
}: ComponentProps<typeof Button>) {
  const into = useContext(IntoComposer)
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
      onClick={
        into && onClick
          ? (event) => into(event.currentTarget, () => onClick(event))
          : onClick
      }
    />
  )
}

/**
 * The tapped pill slides about 12 px down and fades, as if into the
 * composer, then `then` runs; with reduced motion it runs at once. The pill
 * is put back once `then` settles, so a row that shows again shows it whole.
 */
async function slide(pill: HTMLElement, then: () => unknown) {
  if (
    typeof pill.animate !== "function" ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  ) {
    return await then()
  }
  const moving = pill.animate(
    [
      { transform: "translateY(0)", opacity: 1 },
      { transform: "translateY(12px)", opacity: 0 },
    ],
    { duration: INTO_COMPOSER_MS, easing: "ease-in", fill: "forwards" }
  )
  await new Promise((resolve) => setTimeout(resolve, INTO_COMPOSER_MS))
  try {
    return await then()
  } finally {
    moving.cancel()
  }
}

/**
 * Whether the reply above has finished typing in: its Markdown reads
 * `data-status="running"` until the reveal catches up, which can be after
 * the stream itself ends. Null outside a thread, with nothing to wait for.
 */
function useWordsIn(ref: RefObject<HTMLElement | null>): boolean | null {
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
const pillsIn = (words: boolean | null) =>
  words === false
    ? "invisible"
    : "motion-safe:fade-in duration-enter ease-standard motion-safe:animate-in"

type Row = {
  /** The question the replies answer, for a screen reader. */
  label: string
  children: ReactNode
  /**
   * A row above the composer: a tapped pill slides into the composer before
   * it acts, and the row fades out while the composer holds words.
   */
  composer?: boolean
  /** A row above the composer on its way out: it fades and takes no taps. */
  gone?: boolean
  /** Whether the first pill takes the focus as the row shows. */
  takesFocus?: boolean
}

/**
 * A row of quick replies, named for a screen reader by the question they
 * answer. It shows once the reply above has typed in, and takes the focus to
 * its first pill then, unless the owner is typing in the composer.
 */
export function ReplyPills({ composer = false, ...row }: Row) {
  return composer ? <ComposerPills {...row} /> : <Pills {...row} />
}

/** Away while the composer holds words, a tapped pill is on its way or the row is gone, and back once it is empty again. */
function ComposerPills({ gone = false, ...row }: Row) {
  const typed = useAuiState((s) => !s.thread.composer.isEmpty)
  const [leaving, setLeaving] = useState(false)
  const into: Into = (pill, then) => {
    if (leaving) return
    setLeaving(true)
    void slide(pill, then).finally(() => setLeaving(false))
  }
  const away = typed || leaving || gone
  const counted = useContext(PillsShown)?.set
  useEffect(() => {
    if (gone || !counted) return
    counted((rows) => rows + 1)
    return () => counted((rows) => rows - 1)
  }, [gone, counted])
  return (
    <IntoComposer.Provider value={into}>
      <div
        className={cn(
          "transition-[opacity,visibility] duration-200 ease-standard motion-reduce:transition-none",
          away && "invisible opacity-0"
        )}
        data-away={away || undefined}
        inert={away}
      >
        <Pills {...row} />
      </div>
    </IntoComposer.Provider>
  )
}

function Pills({ label, children, takesFocus = true }: Row) {
  const ref = useRef<HTMLFieldSetElement>(null)
  const words = useWordsIn(ref)
  useFocusWhenIdle(!!words && takesFocus, false, ref, "button:not(:disabled)")
  return (
    <fieldset
      className={cn("min-w-0", pillsIn(words))}
      data-slot="reply-pills"
      ref={ref}
    >
      <legend className="sr-only">{label}</legend>
      <ChipRow>{children}</ChipRow>
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
