import type { AvatarId } from "@workspace/contracts"
import { PersonaAvatar } from "@workspace/ui/components/persona"
import { cn } from "@workspace/ui/lib/utils"
import type { CSSProperties } from "react"

/** Each portrait's idle loop and its first frame, by file name. */
const FILES = import.meta.glob<string>("../assets/avatars/*.webp", {
  eager: true,
  import: "default",
})
const file = (name: string) => FILES[`../assets/avatars/${name}.webp`]

/**
 * The assistant's face in a round tile. Reme's own is the persona; the rest
 * are clay portraits from `packages/ui/avatars`, each an animated WebP that
 * blinks at uneven gaps and now and then smiles, with the head's slow sway
 * in CSS so the file holds only what the face does. Anyone who asked for
 * less motion gets the still first frame. `delay` offsets the sway so two on
 * one page do not move in step. Always decoration: the text beside it names
 * the assistant.
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
  const loop = id && id !== "reme" ? file(id) : undefined
  if (!loop) {
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
      <picture>
        <source
          media="(prefers-reduced-motion: reduce)"
          srcSet={file(`${id}-still`)}
        />
        {/* Drawn larger than the tile, so the head fills it and turns about the neck. */}
        <img
          alt=""
          className="absolute -top-[6%] -left-[17.5%] size-[135%] max-w-none origin-[50%_65%] select-none [animation-delay:var(--avatar-delay)] motion-safe:animate-avatar-sway"
          draggable={false}
          height={256}
          src={loop}
          style={{ "--avatar-delay": `${delay}s` } as CSSProperties}
          width={256}
        />
      </picture>
    </span>
  )
}

export { AssistantAvatar }
