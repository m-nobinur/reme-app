import { describe, expect, it } from "vitest"
import { sitemap } from "./sitemap"

describe("the sitemap", () => {
  it("lists the public pages on the origin it is asked from, and nothing behind sign-in", () => {
    const xml = sitemap("https://preview.example")
    expect([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])).toEqual([
      "https://preview.example/",
      "https://preview.example/privacy",
      "https://preview.example/terms",
    ])
  })
})
