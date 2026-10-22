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

const DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
})

const DATE_TIME_PARTS = {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
} as const

const DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  ...DATE_TIME_PARTS,
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
 * `26 Aug 2026, 08:05`. Used where the hour changes what the reader does.
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
  return timeZone === "UTC"
    ? DATE_TIME.format(date)
    : new Intl.DateTimeFormat("en-GB", { ...DATE_TIME_PARTS, timeZone }).format(
        date
      )
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
