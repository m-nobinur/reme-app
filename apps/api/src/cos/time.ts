/**
 * Wall-clock time in the owner's zone, through `Intl` alone. The Now line
 * shows the owner their own time, and a reminder's due time is read back as
 * the owner's time, whatever offset the model wrote on it.
 */

/** The wall clock in `zone` at `at`, to the second, as a UTC epoch. */
function wallAt(at: number, zone: string): number {
  const p: Record<string, number> = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(at)
      .map((part) => [part.type, Number(part.value)])
  )
  const { year = 0, month = 1, day = 1, hour = 0, minute = 0, second = 0 } = p
  return Date.UTC(year, month - 1, day, hour, minute, second)
}

/** `zone`'s offset from UTC at `at`, in milliseconds. */
const offsetAt = (at: number, zone: string) =>
  wallAt(at, zone) - Math.floor(at / 1000) * 1000

/** `at` as ISO 8601 in `zone`'s wall time with its offset, to the second. */
export function zonedIso(at: Date, zone: string): string {
  const offset = offsetAt(at.getTime(), zone) / 60_000
  const sign = offset < 0 ? "-" : "+"
  const hh = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")
  const mm = String(Math.abs(offset) % 60).padStart(2, "0")
  const wall = new Date(wallAt(at.getTime(), zone)).toISOString().slice(0, 19)
  return `${wall}${sign}${hh}:${mm}`
}

const DAY = 86_400_000

/**
 * The instant `written`'s date and time name on the owner's wall clock in
 * `zone`, as ISO 8601 in UTC. The offset written on it is dropped: a model
 * copies the Now line's, which is wrong for a date across a clock change.
 * With no zone the wall time is read as UTC. A time the clocks skip, such
 * as 02:30 on a spring-forward night, moves forward by the gap (03:30); a
 * time they pass twice, on a fall-back night, is the earlier instant.
 * Assumes at most one clock change within a day either side, which holds
 * for every zone in use.
 */
export function wallToUtc(written: string, zone: string | null): string {
  const [date, time] = written.split("T") as [string, string]
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number]
  const [h, mi, s = "0"] = (time.match(/^[\d:.]+/)?.[0] ?? "").split(":")
  const wall = Date.UTC(y, mo - 1, d, Number(h), Number(mi)) + Number(s) * 1000
  if (!zone) return new Date(wall).toISOString()
  const before = wall - offsetAt(wall - DAY, zone)
  const after = wall - offsetAt(wall + DAY, zone)
  const holds = (t: number) => t + offsetAt(t, zone) === wall
  const at =
    holds(before) && holds(after)
      ? Math.min(before, after)
      : holds(after)
        ? after
        : // Held by `before` alone, or by neither: a skipped time, which
          // the offset from before the change moves forward by the gap.
          before
  return new Date(at).toISOString()
}

/** Whether `Intl` knows `zone`, as a browser or the owner named it. */
export function knownZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone })
    return true
  } catch {
    return false
  }
}
