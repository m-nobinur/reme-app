import { historyGroup } from "@workspace/ui/lib/history-groups"
import { expect, it } from "vitest"

// Thursday 22 October 2026, mid-afternoon, in whatever zone the test runs in.
const now = new Date(2026, 9, 22, 15, 0)
const at = (day: number, hour = 9) => new Date(2026, 9, day, hour).toISOString()

it("splits by calendar day, not by hours elapsed", () => {
  expect(historyGroup(at(22, 0), now)).toBe("Today")
  expect(historyGroup(at(21, 23), now)).toBe("Yesterday")
  expect(historyGroup(at(21, 0), now)).toBe("Yesterday")
  expect(historyGroup(at(20), now)).toBe("This week")
  expect(historyGroup(at(16, 0), now)).toBe("This week")
  expect(historyGroup(at(15, 23), now)).toBe("Older")
})

it("counts a time ahead of the clock as today", () => {
  expect(historyGroup(at(23), now)).toBe("Today")
})
