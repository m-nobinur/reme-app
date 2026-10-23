import { ImageIcon } from "@phosphor-icons/react"
import {
  type PaletteFromImage,
  UPLOAD_MAX_BYTES,
  UPLOAD_TYPES,
} from "@workspace/contracts"
import {
  DropTile,
  Swatches,
  sentence,
  TRAY_TILE,
} from "@workspace/ui/components/assistant/question-tray"
import { useTrayServices } from "@workspace/ui/components/assistant/tray-services"
import { buttonVariants } from "@workspace/ui/components/button"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { FIELD_ERROR } from "@workspace/ui/lib/card"
import { sizeText, typesText } from "@workspace/ui/lib/upload"
import { cn } from "@workspace/ui/lib/utils"
import { useState } from "react"

/** Why a picture cannot be read, before it is sent, or null when it can. */
function refusal(file: File) {
  if (!(UPLOAD_TYPES as readonly string[]).includes(file.type))
    return `Choose a ${typesText(UPLOAD_TYPES)} picture.`
  if (file.size > UPLOAD_MAX_BYTES)
    return `That picture is over ${sizeText(UPLOAD_MAX_BYTES)}. Choose a smaller one.`
  return null
}

/**
 * Use colours from a picture, under the palette options: drop or choose a
 * picture, the colours are read (the picture is not kept), and the palette
 * read stays offered as a tile of its own, picked at once. The tray holds
 * what was read, so it is still offered after another palette is picked.
 */
function PalettePicture({
  read,
  setRead,
  checked,
  group,
  onPick,
  reading: startReading = false,
}: {
  read: PaletteFromImage | null
  setRead: (palette: PaletteFromImage) => void
  checked: boolean
  /** The palette options' radio group. */
  group: string
  onPick: (palette: PaletteFromImage) => void
  reading?: boolean | undefined
}) {
  const services = useTrayServices()
  const [reading, setReading] = useState(startReading)
  const [error, setError] = useState<string | null>(null)

  const take = async ([file]: File[]) => {
    if (!file) return
    const refused = refusal(file)
    setError(
      refused ??
        (services
          ? null
          : "Pictures cannot be read here. Pick one of the palettes above.")
    )
    if (refused || !services) return
    setReading(true)
    try {
      const palette = await services.paletteFromImage(file)
      setRead(palette)
      onPick(palette)
    } catch (failure) {
      setError(
        sentence(failure, "The colours could not be read. Try another picture.")
      )
    } finally {
      setReading(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {reading ? (
        <div
          className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3"
          role="status"
        >
          <Skeleton className="h-9 rounded-xl" />
          <span className="text-muted-foreground text-sm">
            Reading the colours
          </span>
        </div>
      ) : read ? (
        <label className={TRAY_TILE}>
          <input
            checked={checked}
            className="sr-only"
            name={group}
            onChange={() => onPick(read)}
            type="radio"
            value="picture"
          />
          <Swatches
            colors={[
              read.stops.paper,
              read.stops.tint,
              read.stops.primary,
              read.stops.ink,
            ]}
          />
          <span className="font-medium text-sm">{read.name}</span>
          <span className="text-muted-foreground text-xs">
            From your picture
          </span>
        </label>
      ) : (
        <DropTile
          accept={UPLOAD_TYPES}
          help="A photo of your van, shopfront or anything in your colours"
          icon={<ImageIcon />}
          onFiles={take}
          title="Use colours from a picture"
        />
      )}
      {read && !reading ? (
        <label
          className={cn(
            buttonVariants({ variant: "ghost", size: "sm" }),
            "cursor-pointer self-start has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-primary"
          )}
        >
          <ImageIcon aria-hidden />
          Use another picture
          <input
            accept={UPLOAD_TYPES.join(",")}
            className="sr-only"
            onChange={(event) => {
              void take(Array.from(event.currentTarget.files ?? []))
              event.currentTarget.value = ""
            }}
            type="file"
          />
        </label>
      ) : null}
      {error ? (
        <p className={FIELD_ERROR} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export { PalettePicture }
