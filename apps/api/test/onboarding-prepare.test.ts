import { describe, expect, it } from "vitest"
import { assistantNames } from "../src/onboarding-prepare.ts"

describe("the assistant names the background call writes", () => {
  it("keeps up to three single, capitalised names", () => {
    expect(assistantNames(["Nora", "Marcus", "Priya", "Tom"])).toEqual([
      "Nora",
      "Marcus",
      "Priya",
    ])
  })

  it("drops Reme, repeats, phrases and anything not a name, and keeps the rest", () => {
    expect(
      assistantNames(["Reme", "nora", "Nora", "NORA", "Mr Clean", "O'Neil", 7])
    ).toEqual(["Nora", "O'Neil"])
  })

  it("offers none for what is not a list", () => {
    expect(assistantNames(null)).toEqual([])
    expect(assistantNames("Reme")).toEqual([])
  })
})
