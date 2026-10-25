import { HandWavingIcon } from "@phosphor-icons/react"
import { cn } from "@workspace/ui/lib/utils"
import { type CSSProperties, type ReactNode, useEffect, useState } from "react"
import faceBlink from "../assets/persona/reme-face-blink.webp"
import faceOpen from "../assets/persona/reme-face-open.webp"
import fullBlink from "../assets/persona/reme-full-blink.webp"
import fullOpen from "../assets/persona/reme-full-open.webp"

const FRAMES = {
  full: { size: 768, open: fullOpen, shut: fullBlink },
  face: { size: 256, open: faceOpen, shut: faceBlink },
}

const LAYER = "absolute inset-0 size-full select-none object-contain"

/**
 * Reme, drawn: a 3D render of the assistant in its headset, from the three.js
 * scene in `packages/ui/persona`, rendered once to images so the page carries
 * no WebGL.
 *
 * Frames stacked, eyes open and eyes shut. It floats slowly and blinks every
 * few seconds, and blinks once more when the pointer arrives, so it notices
 * you without making a show of it. With `greet`, a hello appears beside it as
 * well; that is for one place on a page, not every avatar.
 * With `sway` its head also turns to look about, for a place where it is
 * working. Motion stops for anyone who asked for less. `delay` offsets the cycle so two
 * on one page do not blink in step. Always decoration: the text beside it
 * names Reme.
 *
 * `full` is the whole figure for a stage; `face` is the head, for avatars.
 */
function Persona({
  framing = "full",
  greet = false,
  sway = false,
  delay = 0,
  className,
}: {
  framing?: "full" | "face"
  greet?: boolean
  sway?: boolean
  delay?: number
  className?: string
}) {
  const { size, open, shut } = FRAMES[framing]
  const style = { "--persona-delay": `${delay}s` } as CSSProperties
  const image = { draggable: false, height: size, width: size }
  return (
    <span
      aria-hidden
      className={cn("group/persona relative inline-block shrink-0", className)}
      data-slot="persona"
      style={style}
    >
      <span
        className={cn(
          "absolute inset-0 [animation-delay:var(--persona-delay)]",
          sway
            ? "motion-safe:animate-persona-sway"
            : "motion-safe:animate-persona-float"
        )}
      >
        <img alt="" {...image} className={LAYER} src={open} />
        {/* Hover swaps the idle cycle for a single blink. The shut frame is
            hidden at both ends of either animation, so the swap never shows. */}
        <img
          alt=""
          {...image}
          className={cn(
            LAYER,
            "opacity-0 [animation-delay:var(--persona-delay)] motion-safe:animate-persona-blink motion-safe:group-hover/persona:animate-persona-blink-once group-hover/persona:[animation-delay:0s]"
          )}
          src={shut}
        />
      </span>
      {greet ? <Greeting /> : null}
    </span>
  )
}

/** The visitor's part of the day, by their own clock. */
function greetingFor(hour: number) {
  if (hour >= 5 && hour < 12) return "Good morning"
  if (hour >= 12 && hour < 18) return "Good afternoon"
  if (hour >= 18 && hour < 23) return "Good evening"
  return "Up late? So am I."
}

/** Lands with a touch of overshoot, as if it popped out of the tail. */
const SPRING = "ease-[cubic-bezier(0.34,1.56,0.64,1)]"

/**
 * How a bubble arrives, in three beats: the dot nearest Reme, the next dot,
 * then the bubble. `hover` waits for its persona's hover; `enter` plays once
 * on first paint.
 */
const ARRIVAL = {
  hover: [
    "",
    "group-hover/persona:delay-75",
    "group-hover/persona:delay-150",
  ].map((step) =>
    cn(
      SPRING,
      "scale-50 opacity-0 transition duration-enter group-hover/persona:scale-100 group-hover/persona:opacity-100 motion-reduce:scale-100",
      step
    )
  ),
  enter: [
    "delay-500",
    "[animation-delay:575ms]",
    "[animation-delay:650ms]",
  ].map((step) =>
    cn(
      SPRING,
      "motion-safe:fade-in motion-safe:zoom-in-50 fill-mode-both duration-slow ease-standard motion-safe:animate-in",
      step
    )
  ),
}

const DOT = "absolute rounded-full bg-background shadow-md ring-1 ring-border"

/**
 * Reme speaking: a round bubble with a wave, and a tail of two dots trailing
 * down and to the left, to Reme's head. Place it above and right of the head.
 */
function SpeechBubble({
  title,
  text,
  arrival = "hover",
  className,
}: {
  title: string
  text: string
  arrival?: keyof typeof ARRIVAL
  className?: string
}) {
  const [near, next, bubble] = ARRIVAL[arrival]
  const origin = "origin-bottom-left"
  return (
    <span className={cn("relative inline-block text-left", className)}>
      <span className={cn(DOT, origin, near, "-bottom-6 -left-2 size-1.5")} />
      <span className={cn(DOT, origin, next, "-bottom-3 left-1 size-2.5")} />
      <span
        className={cn(
          origin,
          bubble,
          "flex items-center gap-2.5 rounded-[1.375rem] bg-background py-2.5 pr-4.5 pl-3 shadow-xl ring-1 ring-border"
        )}
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/12 text-primary">
          <HandWavingIcon className="size-4.5" />
        </span>
        <span>
          <span className="block font-medium text-sm">{title}</span>
          <span className="block text-muted-foreground text-xs leading-relaxed">
            {text}
          </span>
        </span>
      </span>
    </span>
  )
}

/**
 * The hello beside the hero's Reme, popping in on hover. The greeting follows
 * the visitor's clock, read after hydration so the server and browser render
 * the same text; until then it says hello.
 */
function Greeting() {
  const [greeting, setGreeting] = useState("Hello")
  useEffect(() => setGreeting(greetingFor(new Date().getHours())), [])
  return (
    <SpeechBubble
      className="absolute top-[4%] left-[88%] w-max lg:max-[1399px]:left-[56%] xl:max-[1399px]:left-[75%]"
      text="I'm Reme. Nice to meet you."
      title={greeting}
    />
  )
}

/** The face in a round tile, the size of an avatar in a conversation. */
function PersonaAvatar({
  className,
  delay,
  sway,
}: {
  className?: string
  delay?: number
  sway?: boolean
}) {
  return (
    <span
      className={cn(
        "relative inline-block size-10 shrink-0 overflow-hidden rounded-full bg-rail ring-1 ring-border",
        className
      )}
    >
      <Persona className="size-full" delay={delay} framing="face" sway={sway} />
    </span>
  )
}

/**
 * Reme on its stage: a disc, a ring and a contact shadow under the figure,
 * which fades up on first paint. Anything pinned around it comes in as
 * children, positioned against the square.
 */
function PersonaStage({
  greet,
  className,
  children,
}: {
  greet?: boolean
  className?: string
  children?: ReactNode
}) {
  return (
    <div aria-hidden className={cn("relative aspect-square", className)}>
      <span className="absolute inset-[9%] rounded-full bg-rail ring-1 ring-border" />
      <span className="absolute inset-[22%] rounded-full ring-1 ring-border" />
      <span className="absolute bottom-[15%] left-1/2 h-[4%] w-[30%] -translate-x-1/2 rounded-[50%] bg-foreground/15 blur-md" />
      <Persona
        className="motion-safe:fade-in motion-safe:zoom-in-95 absolute inset-[12%] size-[76%] fill-mode-both delay-200 duration-slow ease-standard motion-safe:animate-in"
        framing="full"
        greet={greet}
      />
      {children}
    </div>
  )
}

export { Persona, PersonaAvatar, PersonaStage, SpeechBubble }
