/**
 * Dates on the owner screens, formatted once.
 *
 * Locale and time zone are both fixed. They have to be: the server renders in
 * UTC and the browser renders in whatever the reader's machine says, so an
 * unpinned formatter produces two different strings for the same instant and
 * React reports a hydration mismatch. Fixed here, the markup matches and a
 * visual snapshot means the same thing on every machine.
 *
 * When the app learns the owner's time zone it comes in as an argument. It is
 * not a guess this module gets to make.
 */

const DATE_PARTS = { day: "numeric", month: "short", year: "numeric" } as const

const DATE = new Intl.DateTimeFormat("en-GB", {
  ...DATE_PARTS,
  timeZone: "UTC",
})

/** `26 Aug 2026`. Returns null for a missing value, so callers can branch. */
export function formatDate(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : DATE.format(date)
}

/**
 * `8:05 AM`, the one way a time reads anywhere in the app. en-US only for the
 * capital AM and PM; en-GB writes "am". In `timeZone`, else the reader's own,
 * which only a browser-only caller may use.
 */
export const formatTime = (date: Date, timeZone?: string): string =>
  new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
  }).format(date)

/**
 * `26 Aug 2026, 8:05 AM`. Used where the hour changes what the reader does.
 * In UTC unless the caller knows the reader's zone and passes it.
 */
export function formatDateTime(
  value: string | null | undefined,
  timeZone = "UTC"
): string | null {
  if (!value) {
    return null
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const day =
    timeZone === "UTC"
      ? DATE.format(date)
      : new Intl.DateTimeFormat("en-GB", { ...DATE_PARTS, timeZone }).format(
          date
        )
  return `${day}, ${formatTime(date, timeZone)}`
}

/**
 * Minor units to money, e.g. 3500 and `USD` to `$35.00`.
 *
 * `narrowSymbol` because the default under `en-GB` writes USD as `US$35.00`,
 * which is correct and is not what the same price looked like elsewhere in the
 * app. One price, one rendering: an owner comparing an approval against the
 * business profile should not have to work out whether they are the same
 * number.
 */
export function formatMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
  }).format(minor / 100)
}

/** A span of time as it reads in a sentence: `42 s`, `3 min 5 s`. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes ? `${minutes} min ${seconds % 60} s` : `${seconds} s`
}

/** Whole days, hours or minutes, said short: `3 days`, `2 hr`, `25 min`. */
const span = (minutes: number) => {
  if (minutes < 60) return `${minutes} min`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} hr`
  const days = Math.floor(minutes / (24 * 60))
  return `${days} day${days === 1 ? "" : "s"}`
}

/** How far off a time is, as a row says it: `in 25 min`, `2 hr ago`, `just now`. */
export function relativeTime(value: string, now = Date.now()): string | null {
  const ms = Date.parse(value) - now
  if (Number.isNaN(ms)) return null
  const minutes = Math.floor(Math.abs(ms) / 60_000)
  if (minutes < 1) return ms > 0 ? "in a minute" : "just now"
  return ms > 0 ? `in ${span(minutes)}` : `${span(minutes)} ago`
}
