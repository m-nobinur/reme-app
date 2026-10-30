import { describe, expect, it } from "vitest"
import {
  AssignmentState,
  HANDOFF_STATUS,
  HandoffResult,
  HandoffStatus,
} from "../src/assignment.ts"
import { CosEvent } from "../src/cos.ts"

describe("handoff status", () => {
  it("maps every one of the sixteen assignment states, and only them", () => {
    expect(AssignmentState.options).toHaveLength(16)
    expect(Object.keys(HANDOFF_STATUS).sort()).toEqual(
      [...AssignmentState.options].sort()
    )
    for (const status of Object.values(HANDOFF_STATUS)) {
      expect(HandoffStatus.options).toContain(status)
    }
  })

  it("follows the plan's table", () => {
    const by = (status: HandoffStatus) =>
      AssignmentState.options.filter((s) => HANDOFF_STATUS[s] === status)
    expect(by("done")).toEqual(["published"])
    expect(by("needs_owner")).toEqual([
      "blocked_on_information",
      "blocked_on_approval",
    ])
    expect(by("failed")).toEqual(["failed", "cancelled"])
    expect(by("working")).toHaveLength(11)
  })
})

describe("summaries", () => {
  const summary = "x".repeat(1501)
  it("caps a result's and an event's summary at 1,500 characters", () => {
    const base = { evidence: [], metadata: {} }
    expect(
      HandoffResult.safeParse({ ...base, outcome: "done", summary }).success
    ).toBe(false)
    expect(
      CosEvent.safeParse({
        source: "staff",
        evidence: [],
        wake: false,
        summary,
      }).success
    ).toBe(false)
  })
})
