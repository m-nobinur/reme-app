import { PROCEDURES } from "@workspace/skills"
import { describe, expect, it } from "vitest"
import { cosPrefix, DESCRIPTIONS, INSTRUCTIONS } from "../src/cos/agent.ts"

/**
 * The prompt surface (plan §1, after Hermes's `prompts/*.txt`): the rendered
 * core is committed beside this test, so every change to it shows as a diff
 * in review, and it fails once the core, the tool descriptions or the whole
 * prefix grow past their budgets. Topic rules belong in a procedure.
 */

/** Characters, as measured on 2026-11-05: core 12.6k (from 32.6k), descriptions 9.3k, prefix 35.6k. */
const BUDGET = { core: 13_000, descriptions: 9_600, prefix: 36_500 }

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

  it("indexes every procedure in the core and none of their bodies", () => {
    for (const p of PROCEDURES) {
      expect(INSTRUCTIONS).toContain(`${p.name}: ${p.description}`)
      expect(INSTRUCTIONS).not.toContain(p.body.split("\n")[0] as string)
    }
  })
})
