import { describe, expect, it } from "vitest"
import { GOLDEN_ORGS } from "../fixtures/golden.ts"

/**
 * R8, checked rather than asserted in prose: nothing in the golden orgs may
 * read as a real business.
 *
 * The fixtures are the data the mock UI renders, the evals score and the pilot
 * runs on, so a plausible-looking phone number or domain in here is one copy
 * away from a rendered page. Three markers make that impossible to do by
 * accident, and this file is what stops the next fixture edit from dropping
 * one:
 *
 * - every address is under `.invalid`, a top-level domain RFC 2606 reserves so
 *   that it can never be registered or resolve
 * - every phone number is in the North American `555-01xx` range, reserved for
 *   fiction
 * - every org name carries `(fixture)`, so it is marked wherever it renders
 *
 * No database, so this runs in the ordinary `pnpm test` rather than in the
 * `database` job. The seed round trip is `fixtures/seed.test.ts`.
 */

/** Anything with an `@` is an address, and every address must be `.invalid`. */
const ADDRESS = /@/
/** A phone number is written in E.164 here, so it starts with a plus. */
const PHONE = /^\+/
const FICTIONAL_PHONE = /^\+1555 ?01\d\d$/
const URL_LIKE = /^(https?:\/\/|www\.)/

/**
 * Every problem it can find, as a list of readable strings. Returning them
 * rather than throwing is what lets the negative fixture below assert the check
 * fires, which is the only way to know a gate still works.
 */
function fictionalityProblems(value: unknown, path = "$"): string[] {
  if (value instanceof Date) return []
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => fictionalityProblems(v, `${path}[${i}]`))
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) =>
      fictionalityProblems(v, `${path}.${k}`)
    )
  }
  if (typeof value !== "string") return []

  const problems: string[] = []
  if (ADDRESS.test(value) && !value.endsWith(".invalid")) {
    problems.push(`${path}: ${value} is an address outside .invalid`)
  }
  if (URL_LIKE.test(value) && !value.includes(".invalid")) {
    problems.push(`${path}: ${value} is a URL outside .invalid`)
  }
  if (PHONE.test(value) && !FICTIONAL_PHONE.test(value)) {
    problems.push(`${path}: ${value} is outside the 555-01xx range`)
  }
  return problems
}

describe("the golden orgs are unmistakably fictional", () => {
  it("has three orgs", () => {
    expect(GOLDEN_ORGS.map((o) => o.slug)).toEqual([
      "brightclean",
      "mopandbucket",
      "emptyco",
    ])
  })

  it("marks every org name as a fixture", () => {
    for (const { org } of GOLDEN_ORGS) {
      expect(org.name).toContain("(fixture)")
    }
  })

  it("uses no address, URL or phone number that could be real", () => {
    expect(fictionalityProblems(GOLDEN_ORGS)).toEqual([])
  })

  // The negative half. A check nobody has watched fail is not a check: without
  // this, a walker that returned early would leave the test above green over
  // any data at all.
  it("reports the things it is looking for", () => {
    const problems = fictionalityProblems({
      contact: { email: "hello@brightclean.example" },
      phone: "+15551234567",
      site: "https://brightclean.example",
    })
    expect(problems).toHaveLength(3)
    expect(problems.join("\n")).toContain("hello@brightclean.example")
  })
})
