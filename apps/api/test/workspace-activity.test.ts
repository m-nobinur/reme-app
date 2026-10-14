import { BuildActivity } from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import { activityFor, EXPECTED_SECONDS } from "../src/workspace.ts"

describe("build activity rows", () => {
  it("lists the stages reached, earlier ones done", () => {
    const rows = activityFor("full", "implementing")
    expect(rows.map((r) => [r.id, r.done])).toEqual([
      ["planning", 1],
      ["writing", 0],
    ])
    for (const row of rows) BuildActivity.parse(row)
  })

  it("shows none for a quick build or a state outside the stages", () => {
    expect(activityFor("quick", "implementing")).toEqual([])
    expect(activityFor("full", "blocked_on_information")).toEqual([])
  })

  it("keeps p50 under p95 per lane", () => {
    for (const lane of Object.values(EXPECTED_SECONDS)) {
      expect(lane.p50).toBeLessThan(lane.p95)
    }
  })
})
