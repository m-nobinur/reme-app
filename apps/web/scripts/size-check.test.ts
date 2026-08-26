import { describe, expect, it } from "vitest"
// @ts-expect-error the gate is plain ESM, deliberately runnable without a build
import { check } from "./size-check.mjs"

const budget = { limit: 1_048_576, baseline: 229_309, drift: 0.02 }
const at = (gzip: number) => ({ gzip, raw: gzip * 4, printed: gzip / 1024 })

describe("the size gate", () => {
  it("passes a change inside the drift allowance", () => {
    expect(check(at(232_000), budget).failure).toBeNull()
  })

  it("fails growth past the allowance, naming the number to paste", () => {
    const { failure } = check(at(240_000), budget)
    expect(failure).toContain("over the baseline")
    expect(failure).toContain("240000")
  })

  // The bug this gate exists to fix: a build that emits less is not an
  // improvement, it is a build that dropped something.
  it("fails a collapse, not just growth", () => {
    expect(check(at(80), budget).failure).toContain("under the baseline")
  })

  it("fails over the absolute budget before drift is considered", () => {
    expect(check(at(2_000_000), budget).failure).toContain(
      "Raising it is an ADR"
    )
  })

  // A misspelt key makes every comparison NaN, and NaN comparisons are false,
  // so the gate would pass everything.
  it.each([
    ["baselines", { limit: 1_048_576, baselines: 229_309, drift: 0.02 }],
    ["no drift", { limit: 1_048_576, baseline: 229_309 }],
    ["zero baseline", { limit: 1_048_576, baseline: 0, drift: 0.02 }],
  ])("fails on a budget file with %s", (_name, broken) => {
    expect(check(at(229_309), broken).failure).toContain("no usable")
  })

  it("fails when our number and wrangler's disagree", () => {
    const diverged = { gzip: 229_309, raw: 1_046_671, printed: 226.0 }
    expect(check(diverged, budget).failure).toContain(
      "not what Cloudflare receives"
    )
  })
})
