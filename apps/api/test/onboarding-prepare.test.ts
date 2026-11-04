import { describe, expect, it } from "vitest"
import { assistantNames, logoLook } from "../src/onboarding-prepare.ts"

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

describe("the logo's look", () => {
  it("keeps a short plain phrase and drops one too long, with a dash or a price", () => {
    expect(logoLook(" a neatly pruned tree, simple and clear ")).toBe(
      "a neatly pruned tree, simple and clear"
    )
    expect(logoLook("x".repeat(121))).toBeNull()
    expect(logoLook("a tree \u2014 bold")).toBeNull()
    expect(logoLook("a tree with prices from £20")).toBeNull()
    expect(logoLook(42)).toBeNull()
  })
})
