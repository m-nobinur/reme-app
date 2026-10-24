import { CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react"
import {
  type AttentionKind,
  attentionKind,
} from "@workspace/ui/components/attention-card"
import { Button } from "@workspace/ui/components/button"
import { cn, META } from "@workspace/ui/lib/utils"
import { type ReactNode, useEffect, useState } from "react"

export type Update = { id: string; content: ReactNode }

/** How long an update stays in front before the next one comes round. */
const DWELL_MS = 7000

/** The edge each card under the front one shows, in rem, nearest first. */
const EDGE = 0.375

/** The next two updates, as the edges of cards stacked under the front one, farthest first. */
const LAYERS = ["inset-x-6 opacity-50", "inset-x-3 opacity-80"]

/**
 * What waits on the owner, under a new chat's composer: the three that
 * matter most as a deck, one in front and the next two as edges under it.
 * The front one moves on by itself, slowly, and holds while the pointer or
 * focus is on the deck; the arrows step through it. Every update stays
 * mounted, so one mid-publish keeps its state while another is in front.
 */
export function UpdateDeck({ updates }: { updates: readonly Update[] }) {
  const deck = updates.slice(0, 3)
  const [at, setAt] = useState(0)
  const [held, setHeld] = useState(false)
  const count = deck.length
  const front = count ? at % count : 0
  useEffect(() => {
    if (held || count < 2) return
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const timer = setInterval(() => setAt((was) => was + 1), DWELL_MS)
    return () => clearInterval(timer)
  }, [held, count])
  if (!count) return null
  const step = (by: number) => setAt(front + by + count)
  return (
    <section
      aria-label="Updates"
      className="relative isolate"
      data-slot="update-deck"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false)
      }}
      onFocus={() => setHeld(true)}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      style={{ paddingBottom: `${(count - 1) * EDGE}rem` }}
    >
      {LAYERS.slice(3 - count).map((place, depth) => (
        <div
          aria-hidden
          className={cn(
            "absolute h-10 rounded-2xl border border-border bg-card",
            place
          )}
          key={place}
          style={{ bottom: `${depth * EDGE}rem` }}
        />
      ))}
      <div className="relative flex items-center gap-1 rounded-2xl border border-border bg-card pe-2">
        {/* One cell for every update, so the deck is as tall as the tallest. */}
        <div className="grid min-w-0 flex-1 *:[grid-area:1/1]">
          {deck.map((update, index) => (
            <div
              aria-hidden={index !== front}
              className={cn(
                "flex min-w-0 items-center transition-opacity duration-700 ease-out motion-reduce:transition-none",
                index === front ? "opacity-100" : "invisible opacity-0"
              )}
              inert={index !== front}
              key={update.id}
            >
              {update.content}
            </div>
          ))}
        </div>
        {count > 1 ? (
          <div className="flex shrink-0 items-center">
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
      </div>
    </section>
  )
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

/** An update's kind, in the same square as the site's icon. */
export function UpdateKindIcon({ kind }: { kind: AttentionKind }) {
  const { icon: Icon } = attentionKind[kind]
  return (
    <span
      aria-hidden
      className="grid size-9 shrink-0 place-items-center rounded-[25%] bg-muted text-muted-foreground"
    >
      <Icon className="size-5" />
    </span>
  )
}
