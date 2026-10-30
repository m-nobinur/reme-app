import { ReadSkillOutput, SkillName } from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import {
  indexOf,
  PROCEDURES,
  procedure,
  scheduledBy,
  skillsFor,
} from "../src/index.ts"

const corrections = {
  lines: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      staff: "developer" as const,
      text: "Never use stock photos on my site.",
      at: "2026-10-30T09:00:00.000Z",
    },
  ],
}

describe("skills", () => {
  it.each(PROCEDURES)("$name fits the index and read_skill's output", (p) => {
    expect(SkillName.safeParse(p.name).success).toBe(true)
    expect(p.description.length).toBeLessThanOrEqual(60)
    expect(
      ReadSkillOutput.safeParse({
        outcome: "skill",
        name: p.name,
        body: p.body,
      }).success
    ).toBe(true)
  })

  it("lists the CoS's procedures and none of the Developer's corrections", () => {
    const cos = skillsFor("cos", corrections)
    expect(cos.map((s) => s.name)).toEqual([
      "weekly-review",
      "review-reply",
      "quote-reply",
    ])
    expect(indexOf(cos).join("\n")).not.toContain("stock photos")
  })

  it("gives the Developer its corrections", () => {
    const developer = skillsFor("developer", corrections)
    expect(developer).toEqual([
      expect.objectContaining({
        kind: "correction",
        scope: "developer",
        body: "Never use stock photos on my site.",
      }),
    ])
  })

  it("finds a procedure only in its own scope", () => {
    expect(procedure("cos", "review-reply")?.name).toBe("review-reply")
    expect(procedure("developer", "review-reply")).toBeNull()
    expect(procedure("cos", "nothing")).toBeNull()
  })

  it("runs the weekly review on the weekly_report job, Monday at 8", () => {
    expect(scheduledBy("weekly_report")).toMatchObject({
      name: "weekly-review",
      schedule: { kind: "weekly_report", rule: "0 8 * * 1" },
    })
    expect(scheduledBy("heartbeat")).toBeNull()
  })
})
