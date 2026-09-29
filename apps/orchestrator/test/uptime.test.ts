import { afterEach, describe, expect, it, vi } from "vitest"
import { ALERT_FROM, checkUptime, UPTIME_TIMEOUT_MS } from "../src/uptime.ts"

const API = "https://api.example.invalid/health"
const WEB = "https://web.example.invalid/"

/** A fetch that answers each URL with its status, or hangs until its signal aborts. */
function stubFetch(statuses: Record<string, number | "hang">) {
  const fetched = vi.fn(async (url: string, init?: RequestInit) => {
    const status = statuses[url]
    if (status === "hang") {
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason)
        )
      )
    }
    return new Response(null, { status })
  })
  vi.stubGlobal("fetch", fetched)
  return fetched
}

function alerts() {
  const send = vi.fn(async (_message: EmailMessageBuilder) => ({
    messageId: "m",
  }))
  return { send, ALERTS: { send } as unknown as SendEmail }
}

const logged = () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined)
  return () =>
    log.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("the uptime check", () => {
  it("does nothing without HEALTH_URLS, which is staging", async () => {
    const fetched = stubFetch({})
    const lines = logged()
    const { send, ALERTS } = alerts()
    expect(
      await checkUptime({ ALERTS, ALERT_TO: "ops@example.invalid" })
    ).toEqual([])
    expect(fetched).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(lines()).toEqual([])
  })

  it("sends no email when every URL answers 2xx", async () => {
    stubFetch({ [API]: 200, [WEB]: 204 })
    const lines = logged()
    const { send, ALERTS } = alerts()
    const checks = await checkUptime({
      HEALTH_URLS: `${API} ${WEB}`,
      ALERTS,
      ALERT_TO: "ops@example.invalid",
    })
    expect(checks.map((c) => c.ok)).toEqual([true, true])
    expect(send).not.toHaveBeenCalled()
    expect(lines()).toEqual([
      expect.objectContaining({ type: "uptime.checked", ok: true }),
    ])
  })

  it("fails a non-2xx answer and sends one email naming it", async () => {
    stubFetch({ [API]: 503, [WEB]: 200 })
    logged()
    const { send, ALERTS } = alerts()
    const checks = await checkUptime({
      HEALTH_URLS: `${API},${WEB}`,
      ALERTS,
      ALERT_TO: "ops@example.invalid",
    })
    expect(checks[0]).toMatchObject({ url: API, ok: false, status: 503 })
    expect(send).toHaveBeenCalledTimes(1)
    const message = send.mock.calls[0]?.[0]
    expect(message).toMatchObject({
      from: ALERT_FROM,
      to: "ops@example.invalid",
      subject: "Reme production: 1 of 2 health checks failing",
    })
    expect(message?.text).toContain(`${API}  503`)
    expect(message?.text).not.toContain(WEB)
  })

  it("fails a URL that does not answer within the timeout", async () => {
    // The real timer, shortened: the 10 s is asserted, not waited for.
    const timeout = AbortSignal.timeout
    const asked = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => timeout(5))
    stubFetch({ [API]: "hang" })
    logged()
    const { send, ALERTS } = alerts()
    const [check] = await checkUptime({
      HEALTH_URLS: API,
      ALERTS,
      ALERT_TO: "ops@example.invalid",
    })
    expect(asked).toHaveBeenCalledWith(UPTIME_TIMEOUT_MS)
    expect(UPTIME_TIMEOUT_MS).toBe(10_000)
    expect(check).toMatchObject({ url: API, ok: false, error: "TimeoutError" })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("still checks and logs the failure when email is not set up", async () => {
    stubFetch({ [API]: 500 })
    const lines = logged()
    const [check] = await checkUptime({ HEALTH_URLS: API })
    expect(check?.ok).toBe(false)
    expect(lines()).toEqual([
      expect.objectContaining({ type: "uptime.checked", ok: false }),
    ])
  })
})
