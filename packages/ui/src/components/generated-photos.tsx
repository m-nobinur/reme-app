import { ImageIcon } from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import { useId, useRef, useState } from "react"

/**
 * One picture the assistant made rather than the owner supplied. `src` is a
 * thumbnail of it when the wire carries one.
 */
export type GeneratedPhoto = {
  slot_id: string
  section: string
  alt: string
  src?: string | undefined
}

/** What the owner can do with one: swap it, redraw it, or take it out. */
export type PhotoActions = {
  onUseOwn: (photo: GeneratedPhoto, file: File) => void
  onTryAnother: (photo: GeneratedPhoto) => void
  onRemove: (photo: GeneratedPhoto) => void
}

/**
 * The picture, with nothing laid over it. A photo with no thumbnail of its own
 * shows the top of the version's laptop screenshot when it belongs to the
 * hero, which is the first thing that screenshot holds; any other picture, and
 * one that does not load, is a quiet tile, never a broken image.
 */
function Thumb({ src }: { src: string | undefined }) {
  const [broken, setBroken] = useState(false)
  return (
    <div
      className="relative aspect-[3/2] w-28 shrink-0 self-start overflow-hidden rounded-lg border border-border bg-muted"
      data-slot="generated-photo-thumb"
    >
      {src && !broken ? (
        <img
          alt=""
          className="size-full object-cover object-top"
          height={75}
          loading="lazy"
          onError={() => setBroken(true)}
          src={src}
          width={112}
        />
      ) : (
        <ImageIcon
          aria-hidden
          className="absolute top-2 left-2 size-5 text-muted-foreground"
        />
      )}
    </div>
  )
}

/**
 * The review's list of generated photos, under a heading that says they were
 * made, with the three ways to change it. The owner never has to accept a picture they did not choose: an
 * upload always wins the slot.
 */
export function GeneratedPhotos({
  photos,
  actions,
  disabled = false,
  heroShot,
}: {
  photos: readonly GeneratedPhoto[]
  actions: PhotoActions
  disabled?: boolean
  /** The version's home page on a laptop, for a hero photo with no thumbnail. */
  heroShot?: string | undefined
}) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const target = useRef<GeneratedPhoto | null>(null)
  if (photos.length === 0) return null
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="flex flex-col gap-2"
      data-slot="generated-photos"
    >
      <h4 className="font-medium text-sm" id={`${id}-title`}>
        Pictures I made for your site
      </h4>
      <input
        accept="image/jpeg,image/png,image/webp"
        aria-label="Choose your own photo"
        className="sr-only"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file && target.current) actions.onUseOwn(target.current, file)
          event.target.value = ""
        }}
        ref={input}
        type="file"
      />
      <ul className="flex flex-col gap-2">
        {photos.map((photo) => (
          <li className="flex gap-3 rounded-xl border p-3" key={photo.slot_id}>
            <Thumb
              src={
                photo.src ?? (photo.section === "hero" ? heroShot : undefined)
              }
            />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <span className="text-sm">{photo.alt}</span>
              <div className="flex flex-wrap gap-2">
                <Button
                  aria-label={`Use my own photo for ${photo.alt}`}
                  disabled={disabled}
                  onClick={() => {
                    target.current = photo
                    input.current?.click()
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Use my own photo
                </Button>
                <Button
                  aria-label={`Try another picture for ${photo.alt}`}
                  disabled={disabled}
                  onClick={() => actions.onTryAnother(photo)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Try another
                </Button>
                <Button
                  aria-label={`Remove the picture for ${photo.alt}`}
                  disabled={disabled}
                  onClick={() => actions.onRemove(photo)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Remove
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
