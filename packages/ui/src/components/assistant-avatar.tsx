import type { AvatarId } from "@workspace/contracts"
import { PersonaAvatar } from "@workspace/ui/components/persona"
import { cn } from "@workspace/ui/lib/utils"
import { type CSSProperties, useEffect, useState } from "react"

/** Each portrait and its blink and smile patches, by file name. */
const FILES = import.meta.glob<string>("../assets/avatars/*.webp", {
  eager: true,
  import: "default",
})
const file = (name: string) => FILES[`../assets/avatars/${name}.webp`]

const BLINK_MS = 130

/**
 * A face's own clock: a blink every two to seven seconds, now and then two
 * close together, and a smile every seven to sixteen. Every gap is drawn at
 * random per avatar, so no two on a page blink or smile together. Nothing
 * runs for anyone who asked for less motion.
 */
function useAlive() {
  const [shut, setShut] = useState(false)
  const [smiling, setSmiling] = useState(false)
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const timers = new Set<number>()
    const later = (ms: number, then: () => void) => {
      const timer = window.setTimeout(() => {
        timers.delete(timer)
        then()
      }, ms)
      timers.add(timer)
    }
    const between = (low: number, high: number) =>
      low + Math.random() * (high - low)
    const blink = (pair: boolean) => {
      setShut(true)
      later(BLINK_MS, () => setShut(false))
      if (pair) later(BLINK_MS + 180, () => blink(false))
      else later(between(2000, 7000), () => blink(Math.random() < 0.15))
    }
    const smile = () => {
      setSmiling(true)
      later(between(1400, 3000), () => setSmiling(false))
      later(between(7000, 16_000), smile)
    }
    later(between(600, 4000), () => blink(false))
    later(between(2000, 9000), smile)
    return () => {
      for (const timer of timers) clearTimeout(timer)
    }
  }, [])
  return { shut, smiling }
}

const LAYER = "absolute inset-0 size-full max-w-none select-none"

/**
 * The assistant's face in a round tile. Reme's own is the persona; the rest
 * are clay portraits from `packages/ui/avatars`: a portrait with a blink and
 * a smile patch laid over it, each faded in on the face's own clock, and a
 * slow sway of the head in CSS. `delay` offsets the sway so two on one page
 * do not move in step. Always decoration: the text beside it names the
 * assistant.
 */
function AssistantAvatar({
  id,
  delay = 0,
  sway,
  className,
}: {
  id: AvatarId | null
  delay?: number
  /** Reme looks about, for a place where it is working. */
  sway?: boolean
  className?: string
}) {
  const portrait = id && id !== "reme" ? file(id) : undefined
  if (!(id && portrait)) {
    return <PersonaAvatar className={className} delay={delay} sway={sway} />
  }
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-block size-10 shrink-0 overflow-hidden rounded-full bg-rail ring-1 ring-border",
        className
      )}
      data-slot="assistant-avatar"
    >
      <Portrait delay={delay} id={id} portrait={portrait} />
    </span>
  )
}

/** Drawn larger than the tile, so the head fills it and turns about the neck. */
function Portrait({
  id,
  portrait,
  delay,
}: {
  id: AvatarId
  portrait: string
  delay: number
}) {
  const { shut, smiling } = useAlive()
  const image = { draggable: false, height: 256, width: 256 }
  return (
    <span
      className="absolute -top-[6%] -left-[17.5%] size-[135%] origin-[50%_65%] [animation-delay:var(--avatar-delay)] motion-safe:animate-avatar-sway"
      style={{ "--avatar-delay": `${delay}s` } as CSSProperties}
    >
      <img alt="" {...image} className={LAYER} src={portrait} />
      <img
        alt=""
        {...image}
        className={cn(
          LAYER,
          "transition-opacity duration-500",
          smiling ? "opacity-100" : "opacity-0"
        )}
        src={file(`${id}-smile`)}
      />
      {/* Shuts quickly and opens a touch slower, as eyes do. */}
      <img
        alt=""
        {...image}
        className={cn(
          LAYER,
          "transition-opacity",
          shut ? "opacity-100 duration-75" : "opacity-0 duration-100"
        )}
        src={file(`${id}-blink`)}
      />
    </span>
  )
}

export { AssistantAvatar }
