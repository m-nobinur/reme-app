import { describe, expect, it } from "vitest"
import { wallToUtc } from "../src/cos/time.ts"

/**
 * A reminder's due time is the owner's wall-clock time in their zone. The
 * model copies the Now line's offset, which is wrong across a clock change,
 * so the offset it wrote is dropped.
 */
describe("wallToUtc", () => {
  const NY = "America/New_York"

  it("reads a date past a clock change at that date's offset, not the one written", () => {
    // Asked on 2026-10-30 (EDT, -04:00) for Monday 2 November at 9 (EST).
    expect(wallToUtc("2026-11-02T09:00:00-04:00", NY)).toBe(
      "2026-11-02T14:00:00.000Z"
    )
  })

  it("moves a time the clocks skip forward by the gap", () => {
    // 02:30 on 8 March 2026 never happens in New York; it becomes 03:30 EDT.
    expect(wallToUtc("2026-03-08T02:30:00-05:00", NY)).toBe(
      "2026-03-08T07:30:00.000Z"
    )
  })

  it("takes the earlier of a time the clocks pass twice, whatever offset was written", () => {
    // 01:30 on 1 November 2026 happens in EDT, then again in EST.
    for (const offset of ["-04:00", "-05:00"]) {
      expect(wallToUtc(`2026-11-01T01:30:00${offset}`, NY)).toBe(
        "2026-11-01T05:30:00.000Z"
      )
    }
  })

  it("reads the wall time as UTC when the owner's zone is not known", () => {
    expect(wallToUtc("2026-11-02T09:00:00-04:00", null)).toBe(
      "2026-11-02T09:00:00.000Z"
    )
    expect(wallToUtc("2026-11-02T09:00Z", null)).toBe(
      "2026-11-02T09:00:00.000Z"
    )
  })
})
