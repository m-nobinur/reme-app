import { wallText, zonedText, zoneLabel } from "@workspace/ui/lib/zone"
import { expect, it } from "vitest"

// The api reads a reminder's due time as wall time in the owner's zone,
// whatever offset the model wrote. So the card shows the written digits in
// the owner's zone before the yes, and the stored instant in it after.

it("shows the digits a due time was written with, whatever its offset", () => {
  expect(wallText("2026-10-02T08:00:00+10:00")).toBe("2 Oct 2026, 08:00")
  expect(wallText("2026-10-02T08:00:00-04:00")).toBe("2 Oct 2026, 08:00")
  expect(wallText("2026-10-02T08:00:00Z")).toBe("2 Oct 2026, 08:00")
  expect(wallText("not a time")).toBeNull()
})

it("shows a stored instant on the owner's own clock", () => {
  // 08:00 in Sydney (UTC+10 on 2 Oct) and 08:00 in New York (UTC-4).
  expect(zonedText("2026-10-01T22:00:00.000Z", "Australia/Sydney")).toBe(
    "2 Oct 2026, 08:00"
  )
  expect(zonedText("2026-10-02T12:00:00.000Z", "America/New_York")).toBe(
    "2 Oct 2026, 08:00"
  )
})

it("names the zone as the owner reads it", () => {
  expect(zoneLabel("Australia/Sydney")).toBe("Sydney time")
  expect(zoneLabel("America/New_York")).toBe("New York time")
  expect(zoneLabel("UTC")).toBe("UTC")
})
