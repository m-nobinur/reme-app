import { DotsThreeIcon, ImageIcon } from "@phosphor-icons/react"
import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import { cn, META } from "@workspace/ui/lib/utils"
import { type ReactNode, useRef, useState } from "react"

/** One picture on the site, in the section it fills. `src` is its thumbnail. */
export type SitePicture = {
  slot_id: string
  section: string
  alt: string
  generated: boolean
  src: string | null
}

/** What the owner can do with a picture: swap it, redraw it, or take it out. */
export type PictureActions = {
  onUseOwn: (picture: SitePicture, file: File) => void
  onTryAnother: (picture: SitePicture) => void
  onRemove: (picture: SitePicture) => void
}

const ACCEPT = "image/jpeg,image/png,image/webp"

/** A slot by its id, in words: `service_1_card` as `Service 1 card`, `about_hero` as `About main photo`. */
const slotName = (slot: string) => {
  const words = slot.replaceAll("_", " ").replace(/\bhero\b/, "main photo")
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** A thumbnail that is a quiet tile until it loads, and if it never does. */
function Thumb({ src, logo }: { src: string | null; logo?: boolean }) {
  const [broken, setBroken] = useState(false)
  return src && !broken ? (
    <img
      alt=""
      className={cn("size-full", logo ? "object-contain p-6" : "object-cover")}
      loading="lazy"
      onError={() => setBroken(true)}
      src={src}
    />
  ) : (
    <ImageIcon
      aria-hidden
      className="absolute inset-0 m-auto size-6 text-muted-foreground"
    />
  )
}

/** One tile: the picture, its menu at the corner, and what it is under it. */
function Tile({
  label,
  line,
  title,
  disabled,
  children,
  picture,
}: {
  label: string
  line: string
  title?: string
  disabled: boolean
  /** The menu's items. */
  children: ReactNode
  picture: ReactNode
}) {
  return (
    <li className="flex min-w-0 flex-col gap-2" title={title}>
      <div className="relative aspect-[4/3] overflow-hidden rounded-xl border border-border bg-muted">
        {picture}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={`Change ${label.toLowerCase()}`}
                className="absolute top-2 right-2 size-8 rounded-full bg-card/90 shadow-sm backdrop-blur-sm"
                disabled={disabled}
                size="icon"
                variant="secondary"
              />
            }
          >
            <DotsThreeIcon aria-hidden weight="bold" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            {children}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-sm">{label}</span>
        <span className={cn(META, "truncate")}>{line}</span>
      </div>
    </li>
  )
}

/**
 * The logo and every picture on the site, each with a menu of the ways to
 * change it. A change is a new version the owner reviews, never an edit to
 * the live site; an upload always wins its slot over a picture the assistant
 * made.
 */
export function SitePictures({
  logo,
  pictures,
  maker,
  actions,
  onReplaceLogo,
  disabled = false,
  status = null,
}: {
  /** The logo's thumbnail, or null when the org holds none. */
  logo: string | null
  pictures: readonly SitePicture[]
  /** Who made the generated ones: the assistant's name. */
  maker: string
  actions: PictureActions
  onReplaceLogo: (file: File) => void
  disabled?: boolean
  /** What became of the last change, said under the grid. */
  status?: string | null
}) {
  const input = useRef<HTMLInputElement>(null)
  // What the next chosen file is for: the logo, or one picture.
  const target = useRef<SitePicture | "logo" | null>(null)
  const choose = (next: SitePicture | "logo") => {
    target.current = next
    input.current?.click()
  }
  if (!logo && pictures.length === 0) return null
  return (
    <section
      aria-labelledby="site-pictures"
      className="flex flex-col gap-3"
      data-slot="site-pictures"
    >
      <div className="flex flex-col gap-0.5">
        <h2 className="font-medium text-sm" id="site-pictures">
          Pictures and logo
        </h2>
        <p className={META}>
          Each change makes a new version for you to review.
        </p>
      </div>
      <input
        accept={ACCEPT}
        aria-label="Choose a picture"
        className="sr-only"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          const chosen = target.current
          if (file && chosen) {
            if (chosen === "logo") onReplaceLogo(file)
            else actions.onUseOwn(chosen, file)
          }
          event.target.value = ""
        }}
        ref={input}
        type="file"
      />
      <ul className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-3 xl:grid-cols-4">
        {logo ? (
          <Tile
            disabled={disabled}
            label="Logo"
            line="Your logo"
            picture={<Thumb logo src={logo} />}
          >
            <DropdownMenuItem onClick={() => choose("logo")}>
              Replace logo
            </DropdownMenuItem>
          </Tile>
        ) : null}
        {pictures.map((picture) => (
          <Tile
            disabled={disabled}
            key={picture.slot_id}
            label={slotName(picture.slot_id)}
            line={picture.generated ? `Made by ${maker}` : "Your photo"}
            picture={<Thumb src={picture.src} />}
            title={picture.alt}
          >
            <DropdownMenuItem onClick={() => choose(picture)}>
              Use my own photo
            </DropdownMenuItem>
            {picture.generated ? (
              <DropdownMenuItem onClick={() => actions.onTryAnother(picture)}>
                Try another
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              className="text-destructive"
              onClick={() => actions.onRemove(picture)}
            >
              Remove
            </DropdownMenuItem>
          </Tile>
        ))}
      </ul>
      {status ? (
        <p className={META} role="status">
          {status}
        </p>
      ) : null}
    </section>
  )
}
