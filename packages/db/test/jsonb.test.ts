import { describe, expect, it } from "vitest"
import { events, facts } from "../src/schema.ts"

/**
 * A jsonb value through drizzle and postgres.js: drizzle writes it, and
 * postgres.js parses what comes back before drizzle sees it. So the read side
 * is handed the value itself, and must not parse a string a second time.
 */
type Column = {
  mapToDriverValue: (value: unknown) => unknown
  mapFromDriverValue: (value: unknown) => unknown
}
const roundTrip = (column: Column, value: unknown) =>
  column.mapFromDriverValue(
    JSON.parse(column.mapToDriverValue(value) as string)
  )

describe("a jsonb column", () => {
  it.each(["123", "true", "null", "[1,2]", '"quoted"', "Street parking"])(
    "reads the string %s back as that string",
    (value) => {
      expect(roundTrip(facts.value, value)).toBe(value)
    }
  )

  it("reads objects, arrays and scalars back unchanged", () => {
    for (const value of [{ open: "08:00" }, ["a"], 12, true, null]) {
      expect(roundTrip(facts.value, value)).toEqual(value)
    }
    expect(roundTrip(events.payload as Column, { message: "[1]" })).toEqual({
      message: "[1]",
    })
  })
})
