import { logFailure } from "@workspace/db"

/**
 * The USD to GBP rate behind the pound estimate on a Cloudflare price, which
 * Cloudflare quotes and bills in dollars. It is the European Central Bank's
 * daily euro reference rate, the GBP rate over the USD rate, fetched once a
 * day by the hourly firing and kept in `SCHEDULE` under its own key; a name
 * search reads that key and never fetches. The ECB publishes around 16:00 CET
 * on TARGET working days and calls its rates "for information purposes only",
 * so the figure is shown as "about" and never charged.
 */
const ECB_DAILY =
  "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
const FETCH_TIMEOUT_MS = 10_000

export const RATE_KEY = "fx:usd_gbp"
/** After 16:00 CET in summer and winter, so the day's file is out. */
export const RATE_HOUR_UTC = 16
/** A Friday rate still counts on Monday, before the ECB publishes again. */
export const RATE_MAX_DAYS = 3

type Stored = {
  usd_gbp: number
  /** The ECB's reference date. */
  date: string
  /** The UTC day it was fetched, so a weekend's unchanged file is fetched once a day. */
  fetched_on: string
}

/** An error whose name is its code, as `failureCode` logs it. */
const failed = (name: string) => Object.assign(new Error(name), { name })

const DAY = /^\d{4}-\d{2}-\d{2}$/
const day = (at: Date) => at.toISOString().slice(0, 10)

/** The ECB's reference date and pounds per dollar from its daily file, or null if either rate is missing. */
export function parseEcb(xml: string): Pick<Stored, "usd_gbp" | "date"> | null {
  const date = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1]
  const perEuro = (code: string) =>
    Number(
      new RegExp(`currency=['"]${code}['"]\\s+rate=['"]([\\d.]+)['"]`).exec(
        xml
      )?.[1]
    )
  const usd = perEuro("USD")
  const gbp = perEuro("GBP")
  if (!date || !(usd > 0) || !(gbp > 0)) return null
  return { usd_gbp: Number((gbp / usd).toFixed(6)), date }
}

async function stored(kv: KVNamespace): Promise<Stored | null> {
  const value = await kv.get<Partial<Stored>>(RATE_KEY, "json")
  return value &&
    typeof value.usd_gbp === "number" &&
    value.usd_gbp > 0 &&
    DAY.test(value.date ?? "") &&
    DAY.test(value.fetched_on ?? "")
    ? (value as Stored)
    : null
}

/** Pounds per dollar, or undefined when none is stored or its date is over `RATE_MAX_DAYS` days old. */
export async function freshRate(
  kv: KVNamespace,
  now: Date
): Promise<number | undefined> {
  const rate = await stored(kv)
  if (!rate) return undefined
  const days = (Date.parse(day(now)) - Date.parse(rate.date)) / 86_400_000
  return days <= RATE_MAX_DAYS ? rate.usd_gbp : undefined
}

/**
 * Fetches the day's file when nothing is stored, or once a day after
 * `RATE_HOUR_UTC`; a failure is logged and retried by the next hour's firing.
 */
export async function refreshRate(
  env: Pick<Env, "SCHEDULE">,
  now: Date
): Promise<void> {
  try {
    const held = await stored(env.SCHEDULE)
    if (
      held &&
      (held.fetched_on === day(now) || now.getUTCHours() < RATE_HOUR_UTC)
    )
      return
    const response = await fetch(ECB_DAILY, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) throw failed(`ecb.${response.status}`)
    const parsed = parseEcb(await response.text())
    if (!parsed) throw failed("ecb.unparsed")
    await env.SCHEDULE.put(
      RATE_KEY,
      JSON.stringify({ ...parsed, fetched_on: day(now) } satisfies Stored)
    )
  } catch (error) {
    logFailure({ rate: "usd_gbp" }, error)
  }
}

/**
 * The rate a name search shows pounds with: the stored one, else one
 * refresh first, for when the hourly firing has not stored one yet, as on a
 * fresh server. Undefined when the ECB cannot be read either.
 */
export async function rateNow(
  env: Pick<Env, "SCHEDULE">,
  now: Date
): Promise<number | undefined> {
  const held = await freshRate(env.SCHEDULE, now)
  if (held !== undefined) return held
  await refreshRate(env, now)
  return await freshRate(env.SCHEDULE, now)
}
