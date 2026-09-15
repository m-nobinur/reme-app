import { describe, expect, it } from "vitest"
import { ComponentManifest, SiteField, SiteFields } from "../src/site.ts"
import { samples } from "./samples.ts"

describe("SiteField", () => {
  it("takes a required fact and an optional composed string", () => {
    expect(SiteFields.parse(samples.SiteFields)).toEqual(samples.SiteFields)
  })

  it("cannot say required without saying which fact", () => {
    expect(SiteField.safeParse({ kind: "fact", required: true }).success).toBe(
      false
    )
    expect(
      SiteField.safeParse({ kind: "composed", required: true }).success
    ).toBe(false)
    expect(
      SiteField.safeParse({ kind: "fact", fact_key: "phone", required: true })
        .success
    ).toBe(false)
  })
})

describe("ComponentManifest", () => {
  const sample = samples.ComponentManifest as Record<string, unknown>

  it("parses the sample", () => {
    expect(ComponentManifest.parse(sample)).toEqual(sample)
  })

  it("refuses a manifest with no example, a fact key on a prop, or an unknown source", () => {
    expect(
      ComponentManifest.safeParse({ ...sample, examples: [] }).success
    ).toBe(false)
    expect(
      ComponentManifest.safeParse({
        ...sample,
        props: [
          {
            name: "phone",
            type: "string",
            required: false,
            description: "x",
            fact_key: "business.phone",
          },
        ],
      }).success
    ).toBe(false)
    expect(
      ComponentManifest.safeParse({ ...sample, source: "guessed" }).success
    ).toBe(false)
    expect(ComponentManifest.safeParse({ ...sample, version: 1 }).success).toBe(
      false
    )
  })
})
