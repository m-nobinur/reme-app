import { describe, expect, it } from "vitest"
import { previewHost, siteHost, siteUrl, slugFor } from "../src/site.ts"

describe("slugFor", () => {
  const org = "9f1c0b52-6d3a-4d0e-8a44-0c1f2b3a4d5e"

  it("keeps a name's own words and ends with the org's id", () => {
    expect(slugFor("Bright Clean", org)).toBe("bright-clean-9f1c0b52")
  })

  it.each([
    ["Preview", "site-preview-9f1c0b52"],
    ["Preview Cleaning", "site-preview-cleaning-9f1c0b52"],
    ["Domains", "site-domains-9f1c0b52"],
    ["domains!", "site-domains-9f1c0b52"],
  ])("puts a reserved word, %s, behind site-", (name, slug) => {
    expect(slugFor(name, org)).toBe(slug)
  })

  it("leaves a name that only starts with domains alone", () => {
    expect(slugFor("Domains Cleaning", org)).toBe("domains-cleaning-9f1c0b52")
  })
})

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
