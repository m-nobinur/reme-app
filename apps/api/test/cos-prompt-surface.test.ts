import { indexOf, PROCEDURES } from "@workspace/skills"
import type { LanguageModel } from "ai"
import { describe, expect, it } from "vitest"
import {
  type AgentTurn,
  cosAgent,
  cosPrefix,
  DESCRIPTIONS,
  INSTRUCTIONS,
  PROMPT_REVIEW_AT,
} from "../src/cos/agent.ts"

/**
 * The prompt surface (plan §1, after Hermes's `prompts/*.txt`): the rendered
 * core is committed beside this test, so every change to it shows as a diff
 * in review. Its size is measured, never capped, after `hermes
 * prompt-size` (MIT): `pnpm --filter api prompt-size` prints the breakdown,
 * and every run warns once the prefix passes `PROMPT_REVIEW_AT`. Topic rules
 * belong in a procedure.
 */

describe("the CoS's prompt surface", () => {
  it("renders the core as committed", async () => {
    await expect(INSTRUCTIONS).toMatchFileSnapshot("./cos-core-prompt.txt")
  })

  it("measures the prefix and warns past the review line", async () => {
    const descriptions = Object.values(DESCRIPTIONS).join("\n").length
    const prefix = JSON.stringify(await cosPrefix()).length
    const sizes = {
      core: INSTRUCTIONS.length,
      "tool descriptions": descriptions,
      "tool schemas and framing": prefix - INSTRUCTIONS.length - descriptions,
      "whole prefix": prefix,
    }
    const table = Object.entries(sizes)
      .map(
        ([part, chars]) =>
          `${part}: ${chars} chars, ~${Math.ceil(chars / 4)} tokens`
      )
      .join("\n")
    if (process.env.PROMPT_SIZE) console.log(`CoS prompt size\n${table}`)
    if (prefix > PROMPT_REVIEW_AT)
      // Straight to the terminal: Vitest hides a passing test's console.
      process.stderr.write(
        `\nREVIEW: the CoS prefix is ${prefix} chars, past the ${PROMPT_REVIEW_AT} review line. Move one-task rules into their skill or agree the growth with the owner (CLAUDE.md, prompt size).\n${table}\n\n`
      )
    expect(prefix).toBeGreaterThan(INSTRUCTIONS.length)
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
        ) as unknown as { settings: { instructions: { content: string } } }
      ).settings.instructions.content
    const first = sent("00000000-0000-4000-8000-00000000000a", "t1")
    expect(first).toBe(INSTRUCTIONS)
    expect(sent("00000000-0000-4000-8000-00000000000b", "t2")).toBe(first)
  })
})
