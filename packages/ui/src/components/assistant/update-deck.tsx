import { CaretLeftIcon, CaretRightIcon, type Icon } from "@phosphor-icons/react"
import { Docked } from "@workspace/ui/components/assistant/question-tray"
import { usePillsShown } from "@workspace/ui/components/assistant/reply-pill"
import {
  type AttentionKind,
  attentionKind,
} from "@workspace/ui/components/attention-card"
import { Button } from "@workspace/ui/components/button"
import { cn, META } from "@workspace/ui/lib/utils"
import { type ReactNode, useEffect, useRef, useState } from "react"

export type Update = { id: string; content: ReactNode }

/** How long an update stays in front, drawn afresh each time so the stack never ticks like a clock. */
export const DWELL_MS = { min: 3000, max: 6000 }

/** The edge each card under the front one shows, in rem, nearest first. */
const EDGE = 0.375

/** The next two updates, as the edges of cards stacked under the front one, farthest first. */
const LAYERS = ["inset-x-6 opacity-50", "inset-x-3 opacity-80"]

const BOX = "rounded-2xl border border-border bg-card"

const CARD = cn("flex min-w-0 items-center overflow-hidden", BOX)

/** The edges of the `behind` cards stacked under the front one. */
const Edges = ({ behind, className }: { behind: number; className?: string }) =>
  LAYERS.slice(LAYERS.length - behind).map((place, depth) => (
    <div
      aria-hidden
      className={cn("absolute h-10", BOX, place, className)}
      key={place}
      style={{ bottom: `${depth * EDGE}rem` }}
    />
  ))

/**
 * What waits on the owner in a new chat, as a stack: the one that matters
 * most in front, the next two as edges under it. Pointing at it, tabbing
 * into it or tapping it spreads the rest out below the front card, over the
 * page rather than pushing it, three or so in view and any more scrolling;
 * it folds once the pointer and the keyboard's focus have left, or a tap
 * lands elsewhere. Every card stays in the page and in the tab order while
 * folded, so a screen reader reads them all and focus on any one opens the
 * stack.
 */
export function UpdateDeck({ updates }: { updates: readonly Update[] }) {
  const root = useRef<HTMLElement>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [tapped, setTapped] = useState(false)
  useEffect(() => {
    if (!tapped) return
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setTapped(false)
    }
    document.addEventListener("pointerdown", away)
    return () => document.removeEventListener("pointerdown", away)
  }, [tapped])
  const [front, ...rest] = updates
  if (!front) return null
  const open = rest.length > 0 && (hovered || focused || tapped)
  const behind = Math.min(rest.length, LAYERS.length)
  return (
    <section
      aria-label="Updates"
      className="relative isolate"
      data-open={open || undefined}
      data-slot="update-deck"
      onBlur={(event) => {
        if (!root.current?.contains(event.relatedTarget as Node | null)) {
          setFocused(false)
        }
      }}
      // Keyboard focus only: a click's focus would hold it open after the pointer left.
      onFocus={(event) => setFocused(event.target.matches(":focus-visible"))}
      onPointerDown={(event) => {
        if (event.pointerType === "touch") setTapped(true)
      }}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") setHovered(true)
      }}
      onPointerLeave={() => setHovered(false)}
      ref={root}
      style={{ paddingBottom: `${behind * EDGE}rem` }}
    >
      <Edges
        behind={behind}
        className={cn(
          "motion-safe:transition-opacity motion-safe:duration-enter motion-safe:ease-standard",
          open && "opacity-0"
        )}
      />
      <div className="relative">
        <div className={CARD} data-front>
          {front.content}
        </div>
        {rest.length ? (
          // Padding, not a margin, between it and the front card, so the
          // pointer crossing the gap never leaves the stack.
          <div
            className={cn(
              "absolute inset-x-0 top-full z-10 pt-2 motion-safe:transition-[opacity,translate] motion-safe:duration-enter motion-safe:ease-standard",
              !open &&
                "pointer-events-none opacity-0 motion-safe:-translate-y-2"
            )}
            data-slot="update-deck-rest"
          >
            {/* Room around the cards for their focus rings. */}
            <div className="-m-1 flex max-h-56 flex-col gap-2 overflow-y-auto overscroll-contain rounded-2xl bg-background p-1">
              {rest.map((update) => (
                <div className={cn(CARD, "shrink-0")} key={update.id}>
                  {update.content}
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}

/**
 * What waits on the owner in a conversation, as a stack: the three that
 * matter most, one in front and the next two as edges under it. The front
 * one moves on by itself after a few seconds, the next rising out of the
 * stack as it sinks back in. It holds while the pointer is on the stack or
 * focus is in it, stops for that view once the owner uses an arrow, and
 * never moves by itself under reduced motion. Every update stays mounted,
 * so one mid-publish keeps its state while another is in front.
 */
export function UpdatePager({ updates }: { updates: readonly Update[] }) {
  const deck = updates.slice(0, 3)
  const root = useRef<HTMLElement>(null)
  const [at, setAt] = useState(0)
  const [hovered, setHovered] = useState(false)
  const [stepped, setStepped] = useState(false)
  const count = deck.length
  const front = count ? at % count : 0
  useEffect(() => {
    if (hovered || stepped || count < 2) return
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const { min, max } = DWELL_MS
    let timer: ReturnType<typeof setTimeout>
    const dwell = () => {
      timer = setTimeout(
        () => {
          // Read when it fires, not from focus events: a focused card never
          // goes inert, and a focused button that unmounts holds nothing.
          if (!root.current?.contains(document.activeElement)) {
            setAt((was) => was + 1)
          }
          dwell()
        },
        min + Math.random() * (max - min)
      )
    }
    dwell()
    return () => clearTimeout(timer)
  }, [hovered, stepped, count])
  if (!count) return null
  const step = (by: number) => {
    setStepped(true)
    setAt(front + by + count)
  }
  return (
    <section
      aria-label="Updates"
      className="relative isolate"
      data-slot="update-deck"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      ref={root}
      style={{
        paddingBottom: `${(count - 1) * EDGE}rem`,
        ...(count > 1 && { paddingTop: "1.25rem" }),
      }}
    >
      <Edges behind={count - 1} />
      {count > 1 ? (
        // On the card's top edge at its left, mostly above it, so a row's own button keeps
        // the whole width of the row.
        <div className="absolute start-3 top-0 z-10 flex items-center rounded-full border border-border bg-card px-0.5 text-muted-foreground shadow-xs">
          <Button
            aria-label="Previous update"
            onClick={() => step(-1)}
            size="icon-xs"
            variant="ghost"
          >
            <CaretLeftIcon aria-hidden />
          </Button>
          <span className={cn(META, "tabular-nums")}>
            {front + 1}/{count}
          </span>
          <Button
            aria-label="Next update"
            onClick={() => step(1)}
            size="icon-xs"
            variant="ghost"
          >
            <CaretRightIcon aria-hidden />
          </Button>
        </div>
      ) : null}
      <div className={cn("relative overflow-hidden", BOX)}>
        {/* One cell for every update, so the stack is as tall as the tallest. */}
        <div className="grid min-w-0 *:[grid-area:1/1]">
          {deck.map((update, index) => (
            <div
              aria-hidden={index !== front}
              className={cn(
                "flex min-w-0 items-center transition-[opacity,translate,visibility] duration-enter ease-standard motion-reduce:transition-none",
                index === front
                  ? "opacity-100"
                  : "invisible translate-y-2 opacity-0"
              )}
              data-front={index === front || undefined}
              inert={index !== front}
              key={update.id}
            >
              {update.content}
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

/**
 * The stack above a conversation's composer, as one item of its tray: a
 * question card that docks takes the slot, and the stack waits behind it.
 * Quick replies matter most, so while a row of them is up the stack slides
 * down and away, and rises back once they are answered or gone (the
 * collapse after hermes-agent apps/desktop/src/components/assistant-ui/tool/fallback.tsx, MIT).
 */
export function DockedUpdates({ updates }: { updates: readonly Update[] }) {
  const away = usePillsShown()
  return updates.length ? (
    <Docked name="update-stack" settled standing>
      <div
        className={cn(
          "grid motion-safe:transition-[grid-template-rows,opacity,translate,visibility] motion-safe:duration-enter motion-safe:ease-standard",
          away
            ? "invisible translate-y-4 grid-rows-[0fr] opacity-0"
            : "grid-rows-[1fr]"
        )}
        data-away={away || undefined}
        inert={away}
      >
        <div className={cn("min-h-0", away && "overflow-hidden")}>
          <UpdatePager updates={updates} />
        </div>
      </div>
    </Docked>
  ) : null
}

/** One update: what it is about, what it says, and the one thing to do. */
export function UpdateRow({
  icon,
  title,
  meta,
  action,
}: {
  icon: ReactNode
  title: ReactNode
  meta?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3 p-3">
      {icon}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-sm">{title}</span>
        {meta ? <span className={cn(META, "truncate")}>{meta}</span> : null}
      </span>
      {action}
    </div>
  )
}

/** An update's icon, in the same square as the site's. */
export function UpdateIcon({ icon: Glyph }: { icon: Icon }) {
  return (
    <span
      aria-hidden
      className="grid size-9 shrink-0 place-items-center rounded-[25%] bg-muted text-muted-foreground"
    >
      <Glyph className="size-5" />
    </span>
  )
}

/** An update's kind, as its icon. */
export const UpdateKindIcon = ({ kind }: { kind: AttentionKind }) => (
  <UpdateIcon icon={attentionKind[kind].icon} />
)
