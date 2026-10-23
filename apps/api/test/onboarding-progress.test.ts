import { ActivitySegment, type FactValue } from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import type { Onboarding } from "../src/onboarding.ts"
import {
  ONBOARDING_STEPS,
  onboardingSegment,
  onboardingSteps,
} from "../src/onboarding-progress.ts"

const WORK = [
  {
    key: "business.industry",
    value: { name: "Cleaning", category: "cleaning" },
  },
  {
    key: "business.offerings",
    value: { items: ["regular cleans", "end of tenancy"] },
  },
] as const satisfies FactValue[]
const AREA = {
  key: "service_area.text",
  value: { text: "Leeds and about 15 miles around" },
} as const satisfies FactValue
const CONTACT = [
  { key: "business.phone", value: { e164: "+447700900412" } },
  { key: "business.email", value: { address: "hello@sparkle.invalid" } },
] as const satisfies FactValue[]
const ASSISTANT = [
  { key: "assistant.name", value: { name: "Ellie" } },
  { key: "assistant.pronouns", value: { id: "she_her" } },
  { key: "assistant.tone", value: { id: "friendly" } },
] as const satisfies FactValue[]

const at = (
  facts: readonly FactValue[],
  over: Partial<Onboarding> = {}
): Onboarding => ({
  orgId: "0f1e2d3c-4b5a-4968-8776-655443322110",
  facts: [{ key: "business.name", value: { name: "Sparkle" } }, ...facts],
  passed: [],
  closed: [],
  offered: false,
  builder: null,
  orgName: "Sparkle",
  ownerName: "Maria",
  ...over,
})

const states = (o: Onboarding, asked = {}, waiting = false, asking?: string) =>
  Object.fromEntries(
    onboardingSteps(o, asked, waiting, asking).map((s) => [s.id, s.state])
  )

describe("onboardingSteps", () => {
  it("lists the same nine steps from the first moment, in the panel's order", () => {
    for (const o of [at([]), at([...WORK, AREA, ...CONTACT, ...ASSISTANT])]) {
      expect(onboardingSteps(o).map((s) => s.id)).toEqual([...ONBOARDING_STEPS])
    }
    expect(states(at([]))).toEqual({
      work: "now",
      area: "next",
      customers: "next",
      proof: "next",
      contact: "next",
      assistant: "next",
      website: "next",
      quote_form: "next",
      look: "next",
    })
  })

  it("ticks a fact in the turn that states it, with the value as the owner said it", () => {
    // The planner's turn states these; the same facts feed both readers.
    const turn = at(WORK)
    const steps = onboardingSteps(turn)
    expect(steps[0]).toEqual({
      id: "work",
      state: "done",
      value: "Regular cleans, end of tenancy",
    })
    expect(steps[1]).toMatchObject({ id: "area", state: "now" })
    expect(onboardingSteps(at([...WORK, AREA]))[1]).toEqual({
      id: "area",
      state: "done",
      value: "Leeds and about 15 miles around",
    })
  })

  it("leaves an optional detail skipped once it was asked or the owner moved on", () => {
    const early = at([...WORK, AREA])
    expect(states(early).customers).toBe("now")
    expect(states(early, { "business.audience": 1 }).customers).toBe("skipped")
    expect(states(at([...WORK, AREA, ...CONTACT])).customers).toBe("skipped")
    const told = at([
      ...WORK,
      AREA,
      { key: "business.audience", value: { text: "Busy families" } },
    ])
    expect(states(told).customers).toBe("done")
  })

  it("marks the open step waiting while a question is open in the chat", () => {
    const o = at([...WORK, AREA, ...CONTACT])
    expect(states(o).assistant).toBe("now")
    expect(states(o, {}, true, "assistant").assistant).toBe("waiting")
  })

  it("always shows the question being asked: its own step, else the first open one", () => {
    // What sets them apart and the website offer each have a step.
    expect(states(at([...WORK, AREA]), {}, true, "business.proof").proof).toBe(
      "waiting"
    )
    expect(
      states(
        at([...WORK, AREA, ...CONTACT, ...ASSISTANT]),
        {},
        true,
        "build_for_me"
      ).website
    ).toBe("waiting")
    // A question the steps do not name waits on the first open step.
    const unnamed = states(
      at([...WORK, AREA, ...CONTACT]),
      {},
      true,
      "business.tagline"
    )
    expect(Object.values(unnamed)).toContain("waiting")
  })

  it("skips what the website needs on the manual path, and finishes there", () => {
    const manual = at([
      ...WORK,
      AREA,
      ...CONTACT,
      ...ASSISTANT,
      { key: "site.build_mode", value: { mode: "manual" } },
    ])
    expect(states(manual)).toMatchObject({
      quote_form: "skipped",
      look: "skipped",
    })
    expect(onboardingSegment(manual, "2026-10-22T10:00:00.000Z").state).toBe(
      "done"
    )
  })

  it("settles the quote form and look as the owner answers them", () => {
    const building = at(
      [
        ...WORK,
        AREA,
        ...CONTACT,
        ...ASSISTANT,
        { key: "site.build_mode", value: { mode: "assistant" } },
      ],
      { closed: ["design"] }
    )
    expect(states(building)).toMatchObject({
      quote_form: "now",
      look: "done",
    })
    const finished = at(
      [
        ...WORK,
        AREA,
        ...CONTACT,
        ...ASSISTANT,
        { key: "site.build_mode", value: { mode: "assistant" } },
      ],
      { closed: ["design", "quote_form"] }
    )
    expect(states(finished)).toMatchObject({
      quote_form: "skipped",
      look: "done",
    })
  })

  it("leaves nothing open once the build is under way", () => {
    const over = at([...WORK], { offered: true })
    expect(Object.values(states(over))).not.toContain("now")
    expect(onboardingSteps(over)).toHaveLength(ONBOARDING_STEPS.length)
  })
})

describe("onboardingSegment", () => {
  it("is a valid segment named for the business, now or waiting until every step is settled", () => {
    const o = at([...WORK, AREA])
    const now = onboardingSegment(o, "2026-10-22T10:00:00.000Z")
    expect(ActivitySegment.parse(now)).toMatchObject({
      id: "onboarding",
      kind: "onboarding",
      state: "now",
      names: { business: "Sparkle" },
    })
    expect(onboardingSegment(o, now.at, true).state).toBe("waiting")
  })
})
