import { describe, expect, it } from "vitest"
import {
  afterQuiet,
  HEARTBEAT_RULES,
  inQuiet,
  nextFor,
  nextRun,
} from "../src/recurrence.ts"

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

const LONDON = "Europe/London"
const QUIET = { start: "21:00", end: "08:00" }
const CLOCK = { timeZone: LONDON, quietStart: "21:00", quietEnd: "08:00" }

/** Each heartbeat after `from` on `rule`, with the quiet hours applied. */
function beats(rule: string, from: string, n: number) {
  const out: string[] = []
  let after = at(from)
  for (let i = 0; i < n; i++) {
    after = nextFor({ kind: "heartbeat", rule }, CLOCK, after)
    out.push(after.toISOString())
  }
  return out
}

describe("quiet hours", () => {
  it("include the start and leave out the end, across midnight", () => {
    // 2026-10-19 is BST, an hour ahead of UTC.
    expect(inQuiet(at("2026-10-19T19:59:00Z"), LONDON, QUIET)).toBe(false)
    expect(inQuiet(at("2026-10-19T20:00:00Z"), LONDON, QUIET)).toBe(true)
    expect(inQuiet(at("2026-10-19T23:30:00Z"), LONDON, QUIET)).toBe(true)
    expect(inQuiet(at("2026-10-20T06:59:00Z"), LONDON, QUIET)).toBe(true)
    expect(inQuiet(at("2026-10-20T07:00:00Z"), LONDON, QUIET)).toBe(false)
  })

  it("work inside one day, and equal times mean none", () => {
    const lunch = { start: "13:00", end: "14:00" }
    expect(inQuiet(at("2026-10-19T12:30:00Z"), LONDON, lunch)).toBe(true)
    expect(inQuiet(at("2026-10-19T13:00:00Z"), LONDON, lunch)).toBe(false)
    const none = { start: "09:00", end: "09:00" }
    expect(inQuiet(at("2026-10-19T08:00:00Z"), LONDON, none)).toBe(false)
  })

  it("read a zone-less org in UTC", () => {
    expect(inQuiet(at("2026-10-19T20:30:00Z"), null, QUIET)).toBe(false)
    expect(inQuiet(at("2026-10-19T21:30:00Z"), null, QUIET)).toBe(true)
  })

  it("move a time inside them to their end, and leave one outside alone", () => {
    expect(afterQuiet(at("2026-10-19T23:00:00Z"), LONDON, QUIET)).toEqual(
      at("2026-10-20T07:00:00Z")
    )
    expect(afterQuiet(at("2026-10-19T12:00:00Z"), LONDON, QUIET)).toEqual(
      at("2026-10-19T12:00:00Z")
    )
  })

  it("end at 03:30 when the clocks skip their 02:30 end", () => {
    // 2026-03-08 01:00 EST; 02:30 does not exist that night.
    const late = { start: "22:00", end: "02:30" }
    expect(afterQuiet(at("2026-03-08T06:00:00Z"), NY, late)).toEqual(
      at("2026-03-08T07:30:00Z")
    )
  })
})

describe("the heartbeat's next time", () => {
  it("runs every 4 hours by day and waits for 08:00 overnight", () => {
    expect(beats(HEARTBEAT_RULES.default, "2026-10-19T11:30:00Z", 4)).toEqual([
      "2026-10-19T15:00:00.000Z",
      "2026-10-19T19:00:00.000Z",
      "2026-10-20T07:00:00.000Z",
      "2026-10-20T11:00:00.000Z",
    ])
  })

  it("keeps 08:00 local across the autumn change", () => {
    // London leaves BST on 2026-10-25.
    expect(beats(HEARTBEAT_RULES.default, "2026-10-24T19:00:00Z", 2)).toEqual([
      "2026-10-25T08:00:00.000Z",
      "2026-10-25T12:00:00.000Z",
    ])
  })

  it("keeps 08:00 local across the spring change", () => {
    // London enters BST on 2026-03-29.
    expect(beats(HEARTBEAT_RULES.default, "2026-03-28T20:00:00Z", 2)).toEqual([
      "2026-03-29T07:00:00.000Z",
      "2026-03-29T11:00:00.000Z",
    ])
  })

  it("never lands in quiet hours on any dial, through a week of each change", () => {
    for (const rule of Object.values(HEARTBEAT_RULES)) {
      for (const from of ["2026-03-25T00:00:00Z", "2026-10-22T00:00:00Z"]) {
        for (const beat of beats(rule, from, 7 * 24)) {
          expect(inQuiet(at(beat), LONDON, QUIET)).toBe(false)
        }
      }
    }
  })

  it("runs every 8 hours on low and hourly on high", () => {
    expect(beats(HEARTBEAT_RULES.low, "2026-10-19T06:00:00Z", 3)).toEqual([
      "2026-10-19T07:00:00.000Z",
      "2026-10-19T15:00:00.000Z",
      "2026-10-20T07:00:00.000Z",
    ])
    expect(beats(HEARTBEAT_RULES.high, "2026-10-19T18:30:00Z", 2)).toEqual([
      "2026-10-19T19:00:00.000Z",
      "2026-10-20T07:00:00.000Z",
    ])
  })

  it("leaves other kinds to their rule, quiet hours or not", () => {
    const after = at("2026-10-19T12:00:00Z")
    expect(
      nextFor({ kind: "reminder", rule: "0 23 * * *" }, CLOCK, after)
    ).toEqual(at("2026-10-19T22:00:00Z"))
  })
})
