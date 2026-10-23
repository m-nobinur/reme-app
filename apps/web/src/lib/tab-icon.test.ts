import { expect, it } from "vitest"
import { EMPTY_WORKSPACE } from "./attention"
import { tabBadge } from "./tab-icon"

it("dots the tab when something waits on the owner, else while the assistant works", () => {
  expect(tabBadge(null)).toBeNull()
  expect(tabBadge(EMPTY_WORKSPACE)).toBeNull()
  expect(tabBadge({ ...EMPTY_WORKSPACE, building: true })).toBe("working")
  const asked = {
    ...EMPTY_WORKSPACE,
    building: true,
    attention: [{ kind: "question" }] as never,
  }
  expect(tabBadge(asked)).toBe("waiting")
  const segment = (kind: string, state: string) =>
    ({ id: kind, kind, state, steps: [], at: "" }) as never
  const journey = (...segments: never[]) => ({
    ...EMPTY_WORKSPACE,
    activity: {
      journey: segments,
      now: [],
      waiting: [],
      upcoming: [],
      done: [],
    },
  })
  expect(tabBadge(journey(segment("onboarding", "waiting")))).toBe("waiting")
  expect(tabBadge(journey(segment("onboarding", "now")))).toBeNull()
  expect(tabBadge(journey(segment("website", "now")))).toBe("working")
})
