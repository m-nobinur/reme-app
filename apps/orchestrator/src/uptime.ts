import { failureCode } from "@workspace/db"

/**
 * The production uptime check. The zone is on the Free plan, so Cloudflare
 * Health Checks are not available and Notifications has no Workers error-rate
 * alert; this cron is the check instead. Production sets `HEALTH_URLS`, staging
 * does not and runs no cron for it, so a run without it does nothing.
 *
 * Every run logs one `uptime.checked` line, which is the history in Workers
 * Logs whether or not email is set up. A failing run emails through `ALERTS`
 * when the binding and `ALERT_TO` are both present.
 *
 * ponytail: one email per failing run, so an outage sends one every five
 * minutes. Email on state change needs somewhere to keep the last state,
 * which this Worker has nowhere to put yet.
 */

/** Matched character for character against the wrangler config. */
export const UPTIME_CRON = "*/5 * * * *"
export const UPTIME_TIMEOUT_MS = 10_000
/** A sender on the zone; Email Routing only asks that the domain be ours. */
export const ALERT_FROM = "alerts@remeai.co.uk"

export type Check = {
  url: string
  ok: boolean
  ms: number
  status?: number
  /** The failure's code, never its message. */
  error?: string
}

type UptimeEnv = {
  HEALTH_URLS?: string
  ALERT_TO?: string
  ALERTS?: SendEmail
}

async function probe(url: string): Promise<Check> {
  const started = Date.now()
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(UPTIME_TIMEOUT_MS),
    })
    await response.body?.cancel()
    return {
      url,
      ok: response.ok,
      ms: Date.now() - started,
      status: response.status,
    }
  } catch (error) {
    return {
      url,
      ok: false,
      ms: Date.now() - started,
      error: failureCode(error),
    }
  }
}

export async function checkUptime(env: UptimeEnv): Promise<Check[]> {
  const urls = env.HEALTH_URLS?.split(/[\s,]+/).filter(Boolean) ?? []
  if (urls.length === 0) return []
  const checks = await Promise.all(urls.map(probe))
  const failed = checks.filter((c) => !c.ok)
  console.log(
    JSON.stringify({ type: "uptime.checked", ok: failed.length === 0, checks })
  )
  if (failed.length === 0 || !env.ALERTS || !env.ALERT_TO) return checks
  try {
    await env.ALERTS.send({
      from: ALERT_FROM,
      to: env.ALERT_TO,
      subject: `Reme production: ${failed.length} of ${checks.length} health checks failing`,
      text: failed
        .map((c) => `${c.url}  ${c.status ?? c.error}  ${c.ms} ms`)
        .join("\n"),
    })
  } catch (error) {
    // The code only: a send error can name the recipient.
    console.error(
      JSON.stringify({ type: "uptime.alert_failed", code: failureCode(error) })
    )
  }
  return checks
}
