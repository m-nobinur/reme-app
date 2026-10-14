import { BuildActivity } from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import { activityFor, EXPECTED_SECONDS, planOf } from "../src/workspace.ts"

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

describe("a build's Blueprint on the frame", () => {
  const plan = {
    direction: "calm_daylight",
    fonts: "outfit_figtree",
    palette: { kind: "preset", id: "forest" },
    pages: [
      {
        page: "home",
        sections: [
          {
            kind: "hero",
            variant: "wash",
            purpose: "Lead",
            content_notes: null,
          },
        ],
      },
    ],
    images: [],
    voice: "Warm and plain.",
    features: ["One", "Two", "Three", "Four"],
  }
  const row = {
    state: "planning" as const,
    blueprint: plan,
    proposed: { round: 2, review: true, previous: plan },
    decidedRound: 1,
  }

  it("waits on the owner until the round is decided", () => {
    expect(planOf(row).blueprint).toMatchObject({
      round: 2,
      awaiting: true,
      previous: plan,
    })
    expect(planOf({ ...row, decidedRound: 2 }).blueprint?.awaiting).toBe(false)
    expect(
      planOf({ ...row, proposed: { round: 1, review: false } }).blueprint
    ).toMatchObject({ awaiting: false, previous: null })
    expect(planOf({ ...row, state: "implementing" }).blueprint?.awaiting).toBe(
      false
    )
  })

  it("leaves out a build with no plan, or one that no longer parses", () => {
    expect(planOf({ ...row, blueprint: null, proposed: null })).toEqual({})
    expect(planOf({ ...row, blueprint: { direction: "x" } })).toEqual({})
  })
})
