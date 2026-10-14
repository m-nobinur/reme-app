import { describe, expect, it } from "vitest"
import { previewHost, siteHost, siteUrl } from "../src/site.ts"

describe("siteUrl", () => {
  it("keeps staging and production on https with no port", () => {
    expect(
      siteUrl(siteHost("brightclean", "-stg.remeai.co.uk"), undefined)
    ).toBe("https://brightclean-stg.remeai.co.uk")
    expect(siteUrl(previewHost("brightclean", 3, ".remeai.co.uk"), "")).toBe(
      "https://preview-v3-brightclean.remeai.co.uk"
    )
  })

  it("opens local dev's router over http on its port", () => {
    expect(siteUrl(siteHost("brightclean", ".reme.localhost"), "3004")).toBe(
      "http://brightclean.reme.localhost:3004"
    )
    expect(
      siteUrl(previewHost("brightclean", 3, ".reme.localhost"), "3004")
    ).toBe("http://preview-v3-brightclean.reme.localhost:3004")
  })

  it("mints nothing for a config that mixes the two", () => {
    // A port on a real host: the link would leave https or name a stray port.
    expect(() => siteUrl("brightclean-stg.remeai.co.uk", "3004")).toThrow()
    // A local host with no port, or one that is not a port.
    expect(() => siteUrl("brightclean.reme.localhost", undefined)).toThrow()
    for (const port of ["0", "65536", "3004/", "30a4", " 3004", "-1"]) {
      expect(() => siteUrl("brightclean.reme.localhost", port)).toThrow()
    }
    // Only the `.localhost` name is local; a host that merely contains it is not.
    expect(() => siteUrl("brightclean.localhost.evil.com", "3004")).toThrow()
    expect(siteUrl("brightclean.reme.localhost", "65535")).toBe(
      "http://brightclean.reme.localhost:65535"
    )
  })
})
