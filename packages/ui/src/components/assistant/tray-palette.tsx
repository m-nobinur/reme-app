import { ImageIcon, ShuffleIcon } from "@phosphor-icons/react"
import {
  type PaletteFromImage,
  UPLOAD_MAX_BYTES,
  UPLOAD_TYPES,
} from "@workspace/contracts"
import {
  ACCENT_RING,
  DropTile,
  Swatches,
  sentence,
  TRAY_TILE,
} from "@workspace/ui/components/assistant/question-tray"
import { useTrayServices } from "@workspace/ui/components/assistant/tray-services"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { FIELD_ERROR } from "@workspace/ui/lib/card"
import { sizeText, typesText } from "@workspace/ui/lib/upload"
import { cn } from "@workspace/ui/lib/utils"
import { useEffect, useState } from "react"

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
          <PendingSwatches />
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

const samePalette = (a: PaletteFromImage, b: PaletteFromImage) =>
  a.name === b.name &&
  a.stops.paper === b.stops.paper &&
  a.stops.primary === b.stops.primary

/** The palettes a logo page shows at once; the rest wait for Surprise me. */
const LOGO_SHOWN = 4

type LogoRead =
  | { state: "none" }
  | { state: "reading" }
  | { state: "failed"; retry: () => void }
  | { state: "ready"; palettes: PaletteFromImage[] }

/** Asked for as soon as a logo is kept, so they are usually ready by the palette page. */
function useLogoPalettes(assetId: string | undefined): LogoRead {
  const services = useTrayServices()
  const [read, setRead] = useState<{
    id: string
    palettes: PaletteFromImage[] | null
  } | null>(null)
  const [tries, setTries] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies: a retry bumps tries to ask again for the same logo
  useEffect(() => {
    if (!assetId || !services) return
    let live = true
    services
      .logoPalettes(assetId)
      .then(({ palettes }) => live && setRead({ id: assetId, palettes }))
      .catch(() => live && setRead({ id: assetId, palettes: null }))
    return () => {
      live = false
    }
  }, [assetId, services, tries])
  if (!assetId || !services) return { state: "none" }
  if (read?.id !== assetId) return { state: "reading" }
  return read.palettes
    ? { state: "ready", palettes: read.palettes }
    : {
        state: "failed",
        retry: () => {
          setRead(null)
          setTries((n) => n + 1)
        },
      }
}

/** The logo palette an answer picked: the palette itself, or its name as a reload brings it back. */
function logoPick(
  answer: { palette: PaletteFromImage } | { own: string } | object | undefined,
  palettes: readonly PaletteFromImage[]
) {
  if (!answer) return undefined
  if ("palette" in answer)
    return palettes.find((each) => samePalette(each, answer.palette))
  if ("own" in answer) return palettes.find((each) => each.name === answer.own)
  return undefined
}

/**
 * Surprise me moves another palette from the same logo into first place, so
 * every suggestion stays in the logo's colours.
 */
function LogoPalettes({
  read,
  picked,
  group,
  label,
  onPick,
}: {
  read: Extract<LogoRead, { state: "reading" | "ready" }>
  picked: PaletteFromImage | undefined
  group: string
  label: string
  onPick: (palette: PaletteFromImage) => void
}) {
  if (read.state === "reading") {
    return (
      <div className="flex flex-col gap-2" role="status">
        <div className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2">
          {Array.from({ length: LOGO_SHOWN }, (_, at) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholders with no identity
            <PendingSwatches key={at} />
          ))}
        </div>
        <span className="text-muted-foreground text-sm">
          Reading the colours in your logo
        </span>
      </div>
    )
  }
  const { palettes } = read
  const first = palettes.slice(0, LOGO_SHOWN)
  const shown =
    picked && !first.includes(picked) ? [picked, ...first.slice(0, -1)] : first
  const others = palettes.filter((each) => each !== picked)
  const surprise = () => {
    const lucky = others[Math.floor(Math.random() * others.length)]
    if (lucky) onPick(lucky)
  }
  return (
    <>
      <p className="text-muted-foreground text-sm">Built from your logo</p>
      <div
        aria-label={label}
        className="grid grid-cols-1 gap-3 min-[380px]:grid-cols-2"
        role="radiogroup"
      >
        {shown.map((palette) => (
          <label
            className={cn(
              TRAY_TILE,
              "gap-0 overflow-hidden p-0 has-[:checked]:ring-2 has-[:checked]:ring-foreground"
            )}
            key={`${palette.name}${palette.stops.primary}`}
          >
            <input
              checked={palette === picked}
              className="sr-only"
              name={group}
              onChange={() => onPick(palette)}
              type="radio"
              value={palette.name}
            />
            <Swatches
              colors={[
                palette.stops.paper,
                palette.stops.tint,
                palette.stops.primary,
                palette.stops.ink,
              ]}
            />
            <span className="sr-only">{palette.name}</span>
          </label>
        ))}
      </div>
      {others.length > 0 ? <Surprise onClick={surprise} /> : null}
    </>
  )
}

/** A palette still being read, in the shape it lands in: a tile of four bands. */
function PendingSwatches() {
  return (
    <span
      aria-hidden
      className="flex h-10 w-full overflow-hidden rounded-xl border border-border"
    >
      {[0, 1, 2, 3].map((band) => (
        <Skeleton
          className={cn("h-full flex-1 rounded-none", band % 2 && "opacity-60")}
          key={band}
        />
      ))}
    </span>
  )
}

/** Another palette in first place, at the right under the palettes. */
function Surprise({ onClick }: { onClick: () => void }) {
  return (
    <Button
      className={cn("self-end", ACCENT_RING)}
      onClick={onClick}
      size="sm"
      type="button"
      variant="ghost"
    >
      <ShuffleIcon aria-hidden />
      Surprise me
    </Button>
  )
}

export type { LogoRead }
export {
  LogoPalettes,
  logoPick,
  PalettePicture,
  Surprise,
  samePalette,
  useLogoPalettes,
}
