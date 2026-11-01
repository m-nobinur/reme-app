import { GlobeIcon } from "@phosphor-icons/react"
import { cn } from "@workspace/ui/lib/utils"
// Brand marks only; Phosphor stays the UI's icon library. Full colour from
// Iconify's "logos" set where it has the brand, else Simple Icons in the
// brand's own hex. Vendored, so nothing is fetched at runtime.
import awsRoute53 from "../assets/brand-marks/aws-route53.svg" // Iconify logos:aws-route53 1.2.18, Gil Barbara, CC0-1.0
import cloudflare from "../assets/brand-marks/cloudflare.svg" // Iconify logos:cloudflare-icon 1.2.18, Gil Barbara, CC0-1.0
import digitalocean from "../assets/brand-marks/digitalocean.svg" // Iconify logos:digital-ocean-icon 1.2.18, Gil Barbara, CC0-1.0
import dreamhost from "../assets/brand-marks/dreamhost.svg" // Iconify logos:dreamhost 1.2.18, Gil Barbara, CC0-1.0
import gandi from "../assets/brand-marks/gandi.svg" // Simple Icons 16.36.0 gandi, #6640FE, CC0-1.0
import godaddy from "../assets/brand-marks/godaddy.svg" // Simple Icons 16.36.0 godaddy, #1BDBDB, CC0-1.0
import googleCloud from "../assets/brand-marks/google-cloud.svg" // Iconify logos:google-cloud 1.2.18, Gil Barbara, CC0-1.0
import googleSearchConsole from "../assets/brand-marks/google-search-console.svg" // Iconify logos:google-search-console 1.2.18, Gil Barbara, CC0-1.0
import hetzner from "../assets/brand-marks/hetzner.svg" // Simple Icons 16.36.0 hetzner, #D50C2D, CC0-1.0
import hostgator from "../assets/brand-marks/hostgator.svg" // Iconify logos:hostgator-icon 1.2.18, Gil Barbara, CC0-1.0
import hostinger from "../assets/brand-marks/hostinger.svg" // Simple Icons 16.36.0 hostinger, #673DE6, CC0-1.0
import ionos from "../assets/brand-marks/ionos.svg" // Simple Icons 16.36.0 ionos, #003D8F, CC0-1.0
import namecheap from "../assets/brand-marks/namecheap.svg" // Iconify logos:namecheap 1.2.18, Gil Barbara, CC0-1.0
import namesilo from "../assets/brand-marks/namesilo.svg" // Simple Icons 16.36.0 namesilo, #031B4E, CC0-1.0
import ovh from "../assets/brand-marks/ovh.svg" // Simple Icons 16.36.0 ovh, #123F6D, CC0-1.0
import porkbun from "../assets/brand-marks/porkbun.svg" // Simple Icons 16.36.0 porkbun, #EF7878, CC0-1.0
import spaceship from "../assets/brand-marks/spaceship.svg" // Simple Icons 16.36.0 spaceship, #394EFF, CC0-1.0
import squarespace from "../assets/brand-marks/squarespace.svg" // Iconify logos:squarespace 1.2.18, Gil Barbara, CC0-1.0
import vercel from "../assets/brand-marks/vercel.svg" // Iconify logos:vercel-icon 1.2.18, Gil Barbara, CC0-1.0
import wix from "../assets/brand-marks/wix.svg" // Iconify logos:wix 1.2.18, Gil Barbara, CC0-1.0
import wordpress from "../assets/brand-marks/wordpress.svg" // Iconify logos:wordpress-icon 1.2.18, Gil Barbara, CC0-1.0

/** Keyed by mark id: the file's name, as `DNS_PROVIDERS` entries name it. */
const MARKS: Readonly<Record<string, string>> = {
  "aws-route53": awsRoute53,
  cloudflare,
  digitalocean,
  dreamhost,
  gandi,
  godaddy,
  "google-cloud": googleCloud,
  "google-search-console": googleSearchConsole,
  hetzner,
  hostgator,
  hostinger,
  ionos,
  namecheap,
  namesilo,
  ovh,
  porkbun,
  spaceship,
  squarespace,
  vercel,
  wix,
  wordpress,
}

/** The vendored mark for an id, or undefined. */
export const markOf = (mark: string | null | undefined) =>
  mark ? MARKS[mark] : undefined

/**
 * A service's logo on a white tile, as brands draw for a light ground, in
 * both themes; a globe where no library has the brand, never a made-up mark.
 * Decorative: the service's name sits beside it. Forced colours leave the
 * tile as it is, as they leave any picture.
 */
export function BrandMark({
  mark,
  className,
}: {
  mark?: string | null
  className?: string
}) {
  const src = markOf(mark)
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
