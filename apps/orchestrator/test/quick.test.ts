import { describe, expect, it } from "vitest"
import { pickLane } from "../src/quick.ts"

describe("pickLane", () => {
  it("runs small revises quick", () => {
    for (const kind of ["copy", "style", "section"]) {
      expect(pickLane("site.revise", kind)).toEqual({
        lane: "quick",
        change_kind: kind,
      })
    }
  })

  it("runs everything else full", () => {
    expect(pickLane("site.revise", "creative").lane).toBe("full")
    expect(pickLane("site.revise", "photo").lane).toBe("full")
    expect(pickLane("site.revise", undefined)).toEqual({
      lane: "full",
      change_kind: null,
    })
    expect(pickLane("site.revise", "rewrite")).toEqual({
      lane: "full",
      change_kind: null,
    })
    // A first build has nothing to edit, whatever the CoS called it.
    expect(pickLane("site.build", "copy")).toEqual({
      lane: "full",
      change_kind: "copy",
    })
  })
})
