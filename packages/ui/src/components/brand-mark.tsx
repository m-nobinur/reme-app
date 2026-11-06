import { GlobeIcon } from "@phosphor-icons/react"
import { cn } from "@workspace/ui/lib/utils"
import sp34 from "../assets/brand-marks/34sp.png" // official mark from 34sp.com's favicon, fetched 2026-11-01, used only to name the provider
// Brand marks only; Phosphor stays the UI's icon library. Full colour from
// Iconify's "logos" set where it has the brand, else Simple Icons in the
// brand's own hex. Vendored, so nothing is fetched at runtime.
import reg123 from "../assets/brand-marks/123-reg.png" // official mark from 123-reg.co.uk's favicon, fetched 2026-11-01, used only to name the provider
import awsRoute53 from "../assets/brand-marks/aws-route53.svg" // Iconify logos:aws-route53 1.2.18, Gil Barbara, CC0-1.0
import bluehost from "../assets/brand-marks/bluehost.svg" // official mark from bluehost.com's header logo, icon only, fetched 2026-11-01, used only to name the provider
import cloudflare from "../assets/brand-marks/cloudflare.svg" // Iconify logos:cloudflare-icon 1.2.18, Gil Barbara, CC0-1.0
import digitalocean from "../assets/brand-marks/digitalocean.svg" // Iconify logos:digital-ocean-icon 1.2.18, Gil Barbara, CC0-1.0
import dreamhost from "../assets/brand-marks/dreamhost.svg" // Iconify logos:dreamhost 1.2.18, Gil Barbara, CC0-1.0
import dynadot from "../assets/brand-marks/dynadot.svg" // official mark from dynadot.com's favicon, fetched 2026-11-01, used only to name the provider
import fasthosts from "../assets/brand-marks/fasthosts.svg" // official mark from fasthosts.co.uk's header logo, the f only, fetched 2026-11-01, used only to name the provider
import gandi from "../assets/brand-marks/gandi.svg" // Simple Icons 16.36.0 gandi, #6640FE, CC0-1.0
import godaddy from "../assets/brand-marks/godaddy.svg" // Simple Icons 16.36.0 godaddy, #1BDBDB, CC0-1.0
import googleCloud from "../assets/brand-marks/google-cloud.svg" // Iconify logos:google-cloud 1.2.18, Gil Barbara, CC0-1.0
import googleSearchConsole from "../assets/brand-marks/google-search-console.svg" // Iconify logos:google-search-console 1.2.18, Gil Barbara, CC0-1.0
import heartInternet from "../assets/brand-marks/heart-internet.png" // official mark from heartinternet.uk's favicon, fetched 2026-11-01, used only to name the provider
import hetzner from "../assets/brand-marks/hetzner.svg" // Simple Icons 16.36.0 hetzner, #D50C2D, CC0-1.0
import hostgator from "../assets/brand-marks/hostgator.svg" // Iconify logos:hostgator-icon 1.2.18, Gil Barbara, CC0-1.0
import hostinger from "../assets/brand-marks/hostinger.svg" // Simple Icons 16.36.0 hostinger, #673DE6, CC0-1.0
import hover from "../assets/brand-marks/hover.svg" // official mark from hover.com's pinned-tab icon, fetched 2026-11-01, used only to name the provider
import infomaniak from "../assets/brand-marks/infomaniak.svg" // Simple Icons 16.36.0 infomaniak, #0098FF, CC0-1.0
import ionos from "../assets/brand-marks/ionos.svg" // Simple Icons 16.36.0 ionos, #003D8F, CC0-1.0
import krystal from "../assets/brand-marks/krystal.svg" // official mark from krystal.io's favicon, dark-mode rule removed, fetched 2026-11-01, used only to name the provider
import lcn from "../assets/brand-marks/lcn.png" // official mark from lcn.com's touch icon, fetched 2026-11-01, used only to name the provider
import nameCom from "../assets/brand-marks/name-com.svg" // official mark from name.com's favicon, fetched 2026-11-01, used only to name the provider
import namecheap from "../assets/brand-marks/namecheap.svg" // Iconify logos:namecheap 1.2.18, Gil Barbara, CC0-1.0
import namesCoUk from "../assets/brand-marks/names-co-uk.png" // official mark from names.co.uk's touch icon, fetched 2026-11-01, used only to name the provider
import namesilo from "../assets/brand-marks/namesilo.svg" // Simple Icons 16.36.0 namesilo, #031B4E, CC0-1.0
import networkSolutions from "../assets/brand-marks/network-solutions.svg" // official mark from networksolutions.com's header logo, icon only, fetched 2026-11-01, used only to name the provider
import oneCom from "../assets/brand-marks/one-com.png" // official mark from one.com's touch icon, fetched 2026-11-01, used only to name the provider
import ovh from "../assets/brand-marks/ovh.svg" // Simple Icons 16.36.0 ovh, #123F6D, CC0-1.0
import porkbun from "../assets/brand-marks/porkbun.svg" // Simple Icons 16.36.0 porkbun, #EF7878, CC0-1.0
import shopify from "../assets/brand-marks/shopify.svg" // Iconify logos:shopify 1.2.18, Gil Barbara, CC0-1.0
import siteground from "../assets/brand-marks/siteground.png" // official mark from siteground.com's touch icon, fetched 2026-11-01, used only to name the provider
import spaceship from "../assets/brand-marks/spaceship.svg" // Simple Icons 16.36.0 spaceship, #394EFF, CC0-1.0
import squarespace from "../assets/brand-marks/squarespace.svg" // Iconify logos:squarespace 1.2.18, Gil Barbara, CC0-1.0
import transip from "../assets/brand-marks/transip.png" // official mark from transip.nl's touch icon, fetched 2026-11-01, used only to name the provider
import vercel from "../assets/brand-marks/vercel.svg" // Iconify logos:vercel-icon 1.2.18, Gil Barbara, CC0-1.0
import whatsapp from "../assets/brand-marks/whatsapp.svg" // Iconify logos:whatsapp-icon 1.2.18, Gil Barbara, CC0-1.0
import wix from "../assets/brand-marks/wix.svg" // Iconify logos:wix 1.2.18, Gil Barbara, CC0-1.0
import wordpress from "../assets/brand-marks/wordpress.svg" // Iconify logos:wordpress-icon 1.2.18, Gil Barbara, CC0-1.0

/** Keyed by mark id: the file's name, as `DNS_PROVIDERS` entries name it. */
const MARKS: Readonly<Record<string, string>> = {
  "123-reg": reg123,
  "34sp": sp34,
  "aws-route53": awsRoute53,
  bluehost,
  cloudflare,
  digitalocean,
  dreamhost,
  dynadot,
  fasthosts,
  gandi,
  godaddy,
  "google-cloud": googleCloud,
  "google-search-console": googleSearchConsole,
  "heart-internet": heartInternet,
  hetzner,
  hostgator,
  hostinger,
  hover,
  infomaniak,
  ionos,
  krystal,
  lcn,
  "name-com": nameCom,
  namecheap,
  "names-co-uk": namesCoUk,
  namesilo,
  "network-solutions": networkSolutions,
  "one-com": oneCom,
  ovh,
  porkbun,
  shopify,
  siteground,
  spaceship,
  squarespace,
  transip,
  vercel,
  whatsapp,
  wix,
  wordpress,
}

/** The vendored mark for an id, or undefined. */
export const markOf = (mark: string | null | undefined) =>
  mark ? MARKS[mark] : undefined

/**
 * A service's logo on a white tile, as brands draw for a light ground, in
 * both themes; a globe where neither a library nor the provider has a mark, never a made-up one.
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
