import { GlobeIcon } from "@phosphor-icons/react"
import { cn } from "@workspace/ui/lib/utils"
// Brand marks only; Phosphor stays the UI's icon library. Full colour from
// Iconify's "logos" set where it has the brand, else Simple Icons in the
// brand's own hex. Vendored, so nothing is fetched at runtime.
import cloudflare from "../assets/brand-marks/cloudflare.svg" // Iconify logos:cloudflare-icon 1.2.18, Gil Barbara, CC0-1.0
import gandi from "../assets/brand-marks/gandi.svg" // Simple Icons 16.36.0 gandi, #6640FE, CC0-1.0
import godaddy from "../assets/brand-marks/godaddy.svg" // Simple Icons 16.36.0 godaddy, #1BDBDB, CC0-1.0
import googleSearchConsole from "../assets/brand-marks/google-search-console.svg" // Iconify logos:google-search-console 1.2.18, Gil Barbara, CC0-1.0
import hostinger from "../assets/brand-marks/hostinger.svg" // Simple Icons 16.36.0 hostinger, #673DE6, CC0-1.0
import ionos from "../assets/brand-marks/ionos.svg" // Simple Icons 16.36.0 ionos, #003D8F, CC0-1.0
import namecheap from "../assets/brand-marks/namecheap.svg" // Iconify logos:namecheap 1.2.18, Gil Barbara, CC0-1.0
import porkbun from "../assets/brand-marks/porkbun.svg" // Simple Icons 16.36.0 porkbun, #EF7878, CC0-1.0
import squarespace from "../assets/brand-marks/squarespace.svg" // Iconify logos:squarespace 1.2.18, Gil Barbara, CC0-1.0
import wix from "../assets/brand-marks/wix.svg" // Iconify logos:wix 1.2.18, Gil Barbara, CC0-1.0

/** Keyed by the service's name in lower-case letters and digits only. */
const MARKS: Readonly<Record<string, string>> = {
  googlesearchconsole: googleSearchConsole,
  cloudflare,
  godaddy,
  namecheap,
  squarespace,
  wix,
  ionos,
  gandi,
  porkbun,
  hostinger,
}

/**
 * The mark for a service as the owner reads its name ("IONOS", "Cloudflare,
 * Inc."), or undefined. A prefix is enough, since a detected provider may
 * carry a suffix. 123-reg and Fasthosts have no library mark, so none.
 */
export function markOf(name: string): string | undefined {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "")
  return Object.entries(MARKS).find(([brand]) => key.startsWith(brand))?.[1]
}

/**
 * A service's logo on a white tile, as brands draw for a light ground, in
 * both themes; a globe where no library has the brand, never a made-up mark.
 * Decorative: the service's name sits beside it. Forced colours leave the
 * tile as it is, as they leave any picture.
 */
export function BrandMark({
  name,
  className,
}: {
  name: string
  className?: string
}) {
  const src = markOf(name)
  return (
    <span
      className={cn(
        "flex size-14 shrink-0 items-center justify-center rounded-xl border border-border bg-brand-tile text-brand-tile-foreground forced-color-adjust-none",
        className
      )}
      data-slot="brand-mark"
    >
      {src ? (
        <img
          alt=""
          className="size-9 object-contain"
          draggable={false}
          src={src}
        />
      ) : (
        <GlobeIcon aria-hidden className="size-7" />
      )}
    </span>
  )
}
