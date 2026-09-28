import { formatDateTime } from "@workspace/ui/lib/format"

/**
 * Times in the owner's zone. A reminder's due time is read by the api as
 * wall-clock time in the zone the owner's turn carries, whatever offset the
 * model wrote on it, so the owner approves the digits as written, in their
 * own zone, and later sees the stored instant back in that zone.
 */

const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/

/** The date and time an ISO string's digits name, ignoring its offset. */
export function wallText(iso: string): string | null {
  const match = WALL.exec(iso)
  if (!match) return null
  const [, y, mo, d, h, mi] = match.map(Number) as number[]
  // `formatDateTime` formats in UTC, so these digits come back unchanged.
  return formatDateTime(
    new Date(Date.UTC(y ?? 0, (mo ?? 1) - 1, d, h, mi)).toISOString()
  )
}

/** An instant as the clock in `zone` shows it. */
export function zonedText(iso: string, zone: string): string | null {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: zone,
  }).format(at)
}

/** A zone as the owner reads it: "Sydney time", or "UTC". */
export function zoneLabel(zone: string): string {
  if (/^(Etc\/)?(UTC|GMT|Universal|Zulu)$/.test(zone)) return "UTC"
  return `${(zone.split("/").at(-1) ?? zone).replace(/_/g, " ")} time`
}

/** The zone this browser keeps, which is the one a turn carries. */
export const browserZone = () =>
  Intl.DateTimeFormat().resolvedOptions().timeZone
