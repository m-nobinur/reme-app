import type { CompletionReport } from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import {
  CUSTOM_CHECK,
  checkCustomSections,
  parseCustom,
  runGates,
  withCustomSections,
} from "../src/index.ts"

const enc = (s: unknown) => new TextEncoder().encode(JSON.stringify(s))
const report = (...checks: [string, number, string | null][]) =>
  ({
    checks: checks.map(([check, exit_code, output_key]) => ({
      check,
      exit_code,
      output_key,
    })),
  }) as Pick<CompletionReport, "checks">

const FOUND = {
  findings: [
    {
      file: "src/components/custom/Banner.astro",
      rule: "tokens",
      message: "color: tan is a raw colour; use a var(--…) token",
    },
    { file: "src/components/custom/Banner.astro", rule: "empty", message: "x" },
  ],
}

describe("the custom sections check", () => {
  it("passes on exit 0, naming where it came from", () => {
    const r = checkCustomSections(report([CUSTOM_CHECK, 0, "k"]), null)
    expect(r).toMatchObject({ gate: "types", passed: true })
    expect(r.message).toMatch(/build sandbox/)
  })

  it("fails closed when the sandbox never reported it", () => {
    expect(checkCustomSections(report(), null)).toMatchObject({
      gate: "types",
      passed: false,
      message: expect.stringMatching(/no custom sections check/),
    })
  })

  it("fails with the file and the rule of the first finding", () => {
    const r = checkCustomSections(
      report([CUSTOM_CHECK, 1, "sites/x/custom-sections.json"]),
      parseCustom(FOUND)
    )
    expect(r).toMatchObject({
      gate: "types",
      passed: false,
      offending_node: "src/components/custom/Banner.astro",
      evidence_key: "sites/x/custom-sections.json",
    })
    expect(r.message).toMatch(/Banner\.astro breaks the tokens rule/)
    expect(r.message).toMatch(/2 findings/)
  })

  it("fails closed on a non-zero exit with no readable result", () => {
    for (const findings of [null, parseCustom({ findings: [{ file: 1 }] })])
      expect(
        checkCustomSections(report([CUSTOM_CHECK, 2, null]), findings)
      ).toMatchObject({
        passed: false,
        message: expect.stringMatching(/without a result/),
      })
  })

  it("is the types gate's: astro check's failure comes first, then this one's", () => {
    const types = {
      gate: "types" as const,
      passed: false,
      evidence_key: null,
      offending_node: null,
      message: "astro check exited 1",
    }
    const ok = { ...types, passed: true, message: "astro check exited 0" }
    const custom = checkCustomSections(
      report([CUSTOM_CHECK, 1, "k"]),
      parseCustom(FOUND)
    )
    expect(withCustomSections(types, custom)).toBe(types)
    expect(withCustomSections(ok, custom)).toBe(custom)
    expect(
      withCustomSections(ok, { ...custom, passed: true, message: "fine" })
    ).toMatchObject({ passed: true, message: "astro check exited 0; fine" })
  })
})

describe("runGates with the custom sections check", () => {
  const input = (checks: Parameters<typeof report>) => ({
    manifest: null,
    read: async () => null,
    report: report(...checks),
    facts: [],
    budget: { limit: 102_400 },
    evidence: async (key: string) => (key === "custom" ? enc(FOUND) : null),
  })
  const typesOf = async (checks: Parameters<typeof report>) =>
    (await runGates(input(checks))).find((g) => g.gate === "types")

  it("fails the types gate from the evidence JSON, naming file and rule", async () => {
    expect(
      await typesOf([
        ["astro check", 0, null],
        [CUSTOM_CHECK, 1, "custom"],
      ])
    ).toMatchObject({
      passed: false,
      message: expect.stringMatching(/Banner\.astro breaks the tokens rule/),
    })
  })

  it("fails the types gate when a build reports no custom check", async () => {
    expect(await typesOf([["astro check", 0, null]])).toMatchObject({
      passed: false,
      message: expect.stringMatching(/no custom sections check/),
    })
  })

  it("passes the types gate when both ran clean", async () => {
    expect(
      await typesOf([
        ["astro check", 0, null],
        [CUSTOM_CHECK, 0, null],
      ])
    ).toMatchObject({ passed: true })
  })
})
