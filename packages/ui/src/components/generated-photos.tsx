import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { useId, useRef } from "react"

/** One picture the assistant made rather than the owner supplied. */
export type GeneratedPhoto = { slot_id: string; section: string; alt: string }

/** What the owner can do with one: swap it, redraw it, or take it out. */
export type PhotoActions = {
  onUseOwn: (photo: GeneratedPhoto, file: File) => void
  onTryAnother: (photo: GeneratedPhoto) => void
  onRemove: (photo: GeneratedPhoto) => void
}

/**
 * The review's list of generated photos, each badged, with the three ways to
 * change it. The owner never has to accept a picture they did not choose: an
 * upload always wins the slot.
 */
export function GeneratedPhotos({
  photos,
  actions,
  disabled = false,
}: {
  photos: readonly GeneratedPhoto[]
  actions: PhotoActions
  disabled?: boolean
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
          <li
            className="flex flex-col gap-2 rounded-xl border p-3"
            key={photo.slot_id}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">AI-generated</Badge>
              <span className="text-sm">{photo.alt}</span>
            </div>
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
          </li>
        ))}
      </ul>
    </section>
  )
}
