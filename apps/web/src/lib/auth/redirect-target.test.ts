import { describe, expect, it } from "vitest"
import { safeReturnTo } from "./redirect-target"

describe("safeReturnTo", () => {
  it("keeps an in-app path", () => {
    expect(safeReturnTo("/app/staff")).toBe("/app/staff")
    expect(safeReturnTo("/app?page=2#top")).toBe("/app?page=2#top")
  })

  it("refuses another origin", () => {
    for (const value of [
      "https://evil.example/steal",
      "http://evil.example",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "data:text/html,<script>",
    ]) {
      expect(safeReturnTo(value), value).toBe("/app")
    }
  })

  it("refuses a control character hiding inside a path", () => {
    // A newline is enough to make a header parser or a URL parser disagree
    // with a printable-only check about where the value ends.
    expect(safeReturnTo("/app\n/../..//evil.example")).toBe("/app")
    expect(safeReturnTo("/\t/evil.example")).toBe("/app")
  })

  it("refuses anything that is not a non-empty bounded string", () => {
    for (const value of [undefined, null, 42, {}, [], "", "/".repeat(600)]) {
      expect(safeReturnTo(value)).toBe("/app")
    }
  })

  it("uses the fallback it was given", () => {
    expect(safeReturnTo("https://evil.example", "/sign-in")).toBe("/sign-in")
  })
})
