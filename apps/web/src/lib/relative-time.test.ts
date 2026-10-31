import { relativeTime } from "@workspace/ui/lib/format"
import { expect, it } from "vitest"

const NOW = Date.parse("2026-10-24T12:00:00.000Z")
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()

it("says how far off a time is, in minutes, hours and minutes, or days", () => {
  expect(relativeTime(at(0.5), NOW)).toBe("in a minute")
  expect(relativeTime(at(-0.5), NOW)).toBe("just now")
  expect(relativeTime(at(25), NOW)).toBe("in 25 min")
  expect(relativeTime(at(-90), NOW)).toBe("1 hr 30 min ago")
  expect(relativeTime(at(100), NOW)).toBe("in 1 hr 40 min")
  expect(relativeTime(at(120), NOW)).toBe("in 2 hr")
  expect(relativeTime(at(24 * 60), NOW)).toBe("in 1 day")
  expect(relativeTime(at(-3 * 24 * 60 - 5), NOW)).toBe("3 days ago")
  expect(relativeTime("not a time", NOW)).toBeNull()
})
