import { describe, expect, it } from "vitest"
import { checkInteraction, parseInteraction } from "../src/index.ts"

const run = (
  exit_code: number,
  key: string | null = "sites/x/interaction.json"
) => ({
  exit_code,
  key,
})

describe("the interaction gate", () => {
  it("passes a clean run and keeps its evidence", () => {
    expect(
      checkInteraction(run(0), parseInteraction({ pages: 7, findings: [] }))
    ).toEqual({
      gate: "interaction",
      passed: true,
      evidence_key: "sites/x/interaction.json",
      offending_node: null,
      message: "7 page(s) worked in a browser at 390, 768 and 1440 px",
    })
  })

  it("fails each finding with its page and width, and names the first", () => {
    const result = parseInteraction({
      pages: 3,
      findings: [
        { check: "console", path: "/about/", width: 390, detail: "boom" },
        {
          check: "link",
          path: "/",
          width: null,
          detail:
            "/nowhere/ is linked from the menu or footer and the build has no such page",
        },
        {
          check: "form",
          path: "/quote/",
          width: 390,
          detail: "pressing the submit button sent nothing",
        },
      ],
    })
    const gate = checkInteraction(run(1), result)
    expect(gate).toMatchObject({
      passed: false,
      offending_node: "/about/ console",
    })
    for (const part of [
      "3 problem(s)",
      "- console on /about/ at 390 px: boom",
      "- link on /: /nowhere/ is linked",
      "- form on /quote/ at 390 px: pressing the submit button sent nothing",
      "node /tmp/interaction.mjs dist",
    ])
      expect(gate.message).toContain(part)
  })

  it("spells out at most eight findings and counts the rest", () => {
    const findings = Array.from({ length: 11 }, (_, i) => ({
      check: "console",
      path: `/p${i}/`,
      width: 768,
      detail: "boom",
    }))
    const { message } = checkInteraction(
      run(1),
      parseInteraction({ pages: 11, findings })
    )
    expect(message).toContain("/p7/")
    expect(message).not.toContain("/p8/")
    expect(message).toContain("and 3 more in the evidence")
  })

  it("fails closed when the run left no result, or did not run", () => {
    expect(checkInteraction(run(2, null), null)).toMatchObject({
      passed: false,
      evidence_key: null,
      message:
        "the browser check exited 2 without a result, so the pages are unchecked",
    })
    // A clean exit code is not trusted without its JSON.
    expect(checkInteraction(run(0), null).passed).toBe(false)
    for (const absent of [null, undefined])
      expect(checkInteraction(absent, null)).toMatchObject({
        passed: false,
        message: "the pages were not tried in a browser",
      })
  })

  it("fails a non-zero exit that came with no findings", () => {
    expect(
      checkInteraction(run(1), parseInteraction({ pages: 2, findings: [] }))
        .passed
    ).toBe(false)
  })

  it("reads only the shape the script writes", () => {
    for (const bad of [null, {}, { pages: "3", findings: [] }, { pages: 3 }])
      expect(parseInteraction(bad)).toBeNull()
    expect(
      parseInteraction({
        pages: 1,
        findings: [{ check: "menu", path: "/", width: "390" }],
      })
    ).toEqual({
      pages: 1,
      findings: [{ check: "menu", path: "/", width: null, detail: "" }],
    })
  })
})
