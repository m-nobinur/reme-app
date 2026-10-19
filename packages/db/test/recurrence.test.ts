import { describe, expect, it } from "vitest"
import { nextRun } from "../src/recurrence.ts"

const NY = "America/New_York"
const at = (iso: string) => new Date(iso)

/** Each occurrence after `from`, in order. */
function runs(rule: string, zone: string | null, from: string, n: number) {
  const out: string[] = []
  let after = at(from)
  for (let i = 0; i < n; i++) {
    after = nextRun(rule, zone, after)
    out.push(after.toISOString())
  }
  return out
}

describe("the next occurrence of a rule", () => {
  it("fires 01:30 once on the night it happens twice", () => {
    // 2026-11-01: 01:30 EDT is 05:30Z, and 01:30 EST an hour later is skipped.
    expect(runs("30 1 * * *", NY, "2026-10-31T12:00:00Z", 3)).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
      "2026-11-03T06:30:00.000Z",
    ])
    expect(nextRun("30 1 * * *", NY, at("2026-11-01T05:30:00Z"))).toEqual(
      at("2026-11-02T06:30:00Z")
    )
  })

  it("fires 02:30 once, at 03:30, on the night it does not exist", () => {
    expect(runs("30 2 * * *", NY, "2026-03-07T12:00:00Z", 3)).toEqual([
      "2026-03-08T07:30:00.000Z",
      "2026-03-09T06:30:00.000Z",
      "2026-03-10T06:30:00.000Z",
    ])
  })

  it("is strictly after the instant it is given", () => {
    expect(nextRun("0 9 * * *", NY, at("2026-10-19T13:00:00Z"))).toEqual(
      at("2026-10-20T13:00:00Z")
    )
  })

  it("reads a zone-less org's rule in UTC", () => {
    expect(nextRun("0 7 * * 1", null, at("2026-10-19T08:00:00Z"))).toEqual(
      at("2026-10-26T07:00:00Z")
    )
  })

  it("refuses a rule that is not five-part cron, or a zone that is not one", () => {
    expect(() => nextRun("* * * * * *", NY, new Date())).toThrow()
    expect(() => nextRun("tomorrow", NY, new Date())).toThrow()
    expect(() => nextRun("0 9 * * *", "Not/AZone", new Date())).toThrow()
  })
})
