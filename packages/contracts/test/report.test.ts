import { describe, expect, it } from "vitest"
import { CompletionReport, SiteReview } from "../src/report.ts"
import { ACCEPTED, REFUSED, verdict } from "./json-schema.ts"
import { samples } from "./samples.ts"

const old = samples.CompletionReport as Record<string, unknown>
const pair = {
  before: "We clean houses",
  after: "Spotless homes",
  pages: ["/"],
}
const note = {
  about: "hero heading",
  why: "Leads with the result an owner pays for.",
}
const report = (over: object) => ({ ...old, ...over })

describe("CompletionReport", () => {
  it.each([
    ["a report from before text changes and notes", old],
    [
      "a report with text changes and notes",
      report({ text_changes: [pair], text_changes_left: 0, notes: [note] }),
    ],
    [
      "every cap reached",
      report({
        text_changes: Array(8).fill({
          before: "a".repeat(300),
          after: "",
          pages: Array(5).fill("/"),
        }),
        text_changes_left: 12,
        notes: Array(8).fill({ about: "a".repeat(80), why: "a".repeat(300) }),
      }),
    ],
  ])("accepts %s", (_name, value) => {
    expect(verdict("CompletionReport", CompletionReport, value)).toEqual(
      ACCEPTED
    )
  })

  it.each([
    ["nine text changes", report({ text_changes: Array(9).fill(pair) })],
    [
      "a before over 300",
      report({ text_changes: [{ ...pair, before: "a".repeat(301) }] }),
    ],
    [
      "an after over 300",
      report({ text_changes: [{ ...pair, after: "a".repeat(301) }] }),
    ],
    [
      "six pages",
      report({ text_changes: [{ ...pair, pages: Array(6).fill("/") }] }),
    ],
    ["no pages", report({ text_changes: [{ ...pair, pages: [] }] })],
    ["a negative count left", report({ text_changes_left: -1 })],
    ["nine notes", report({ notes: Array(9).fill(note) })],
    [
      "an about over 80",
      report({ notes: [{ ...note, about: "a".repeat(81) }] }),
    ],
    ["a why over 300", report({ notes: [{ ...note, why: "a".repeat(301) }] })],
    ["a blank why", report({ notes: [{ ...note, why: "  " }] })],
  ])("refuses %s", (_name, value) => {
    expect(verdict("CompletionReport", CompletionReport, value)).toEqual(
      REFUSED
    )
  })
})

describe("SiteReview", () => {
  const review = samples.SiteReview as { findings: Record<string, unknown>[] }
  const [finding] = review.findings
  const withFinding = (over: object) => ({
    ...review,
    findings: [{ ...finding, ...over }],
  })

  it("accepts twenty findings", () => {
    expect(
      verdict("SiteReview", SiteReview, {
        ...review,
        findings: Array(20).fill(finding),
        findings_left: 3,
      })
    ).toEqual(ACCEPTED)
  })

  it.each([
    ["twenty-one findings", { ...review, findings: Array(21).fill(finding) }],
    ["five strengths", { ...review, strengths: Array(5).fill("Clear") }],
    ["a verdict over 300", { ...review, verdict: "a".repeat(301) }],
    ["an id over 12", withFinding({ id: "f".repeat(13) })],
    ["an unknown area", withFinding({ area: "speed" })],
    ["an unknown source", withFinding({ from: "model" })],
  ])("refuses %s", (_name, value) => {
    expect(verdict("SiteReview", SiteReview, value)).toEqual(REFUSED)
  })
})
