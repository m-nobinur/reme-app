import type { Blueprint } from "@workspace/contracts"
import { CHANGE_PREFIX } from "@workspace/ui/lib/blueprint"
import { describe, expect, it } from "vitest"
import type { Workspace } from "@/lib/api/types"
import { awaitingPlan, planNote } from "./blueprint-plan"

const PLAN = { direction: "calm_daylight" } as unknown as Blueprint
const build = (id: string, awaiting: boolean | null) => ({
  assignment_id: id,
  state: "planning",
  ...(awaiting === null
    ? {}
    : { blueprint: { plan: PLAN, round: 2, previous: null, awaiting } }),
})
const workspace = (...builds: object[]) => ({ builds }) as unknown as Workspace

describe("the chat's Blueprint card", () => {
  it("draws the newest build whose plan waits on the owner", () => {
    expect(
      awaitingPlan(
        workspace(build("a", null), build("b", false), build("c", true))
      )
    ).toEqual({
      assignmentId: "c",
      plan: PLAN,
      round: 2,
      previous: null,
      awaiting: true,
    })
    expect(awaitingPlan(workspace(build("b", false)))).toBeNull()
    expect(awaitingPlan(null)).toBeNull()
  })

  it("takes a message as a note only when it finishes Change something", () => {
    expect(planNote(`${CHANGE_PREFIX}warmer colours `)).toBe("warmer colours")
    expect(planNote("warmer colours")).toBeNull()
    // The prefix alone says nothing to change.
    expect(planNote(CHANGE_PREFIX)).toBeNull()
  })
})
