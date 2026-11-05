import { indexOf, PROCEDURES } from "@workspace/skills"
import type { LanguageModel } from "ai"
import { describe, expect, it } from "vitest"
import {
  type AgentTurn,
  PROMPT_BUDGET as BUDGET,
  cosAgent,
  cosPrefix,
  DESCRIPTIONS,
  INSTRUCTIONS,
} from "../src/cos/agent.ts"

/**
 * The prompt surface (plan §1, after Hermes's `prompts/*.txt`): the rendered
 * core is committed beside this test, so every change to it shows as a diff
 * in review, and it fails once the core, the tool descriptions or the whole
 * prefix grow past their budgets. Topic rules belong in a procedure.
 */

describe("the CoS's prompt surface", () => {
  it("renders the core as committed", async () => {
    await expect(INSTRUCTIONS).toMatchFileSnapshot("./cos-core-prompt.txt")
  })

  it("keeps the core, the tool descriptions and the prefix within budget", async () => {
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(BUDGET.core)
    expect(Object.values(DESCRIPTIONS).join("\n").length).toBeLessThanOrEqual(
      BUDGET.descriptions
    )
    expect(JSON.stringify(await cosPrefix()).length).toBeLessThanOrEqual(
      BUDGET.prefix
    )
  })

  it("indexes every skill in the core and none of their bodies", () => {
    for (const p of PROCEDURES) {
      expect(INSTRUCTIONS).toContain(indexOf([p])[0])
      expect(INSTRUCTIONS).not.toContain(p.body.split("\n")[0] as string)
      for (const part of p.parts) {
        expect(INSTRUCTIONS).not.toContain(part.body.split("\n")[0] as string)
      }
    }
  })

  it("renders the core byte for byte the same for two orgs and two turns", () => {
    const sent = (orgId: string, turnId: string) =>
      (
        cosAgent(
          { turn: { orgId, turnId, sessionId: turnId } } as AgentTurn,
          {} as LanguageModel,
          "act"
        ) as unknown as { settings: { instructions: string } }
      ).settings.instructions
    const first = sent("00000000-0000-4000-8000-00000000000a", "t1")
    expect(first).toBe(INSTRUCTIONS)
    expect(sent("00000000-0000-4000-8000-00000000000b", "t2")).toBe(first)
  })
})
