import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { everyMinute, thisMoment } from "./minute-clock"

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-10-25T10:00:40Z"))
})
afterEach(() => vi.useRealTimers())

it("ticks on the minute, then every 60 s, with the time at the tick", () => {
  const tick = vi.fn()
  const stop = everyMinute(tick)
  vi.advanceTimersByTime(19_999)
  expect(tick).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(tick).toHaveBeenCalledTimes(1)
  expect(new Date(thisMoment()).toISOString()).toBe("2026-10-25T10:01:00.000Z")
  vi.advanceTimersByTime(60_000)
  expect(tick).toHaveBeenCalledTimes(2)
  stop()
  vi.advanceTimersByTime(120_000)
  expect(tick).toHaveBeenCalledTimes(2)
})

it("stops before the first tick without leaving a timer", () => {
  const tick = vi.fn()
  everyMinute(tick)()
  expect(vi.getTimerCount()).toBe(0)
})
