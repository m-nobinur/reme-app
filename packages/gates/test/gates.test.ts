import { createHash } from "node:crypto"
import {
  type CompletionReport,
  type FactRecord,
  GateResult,
} from "@workspace/contracts"
import { describe, expect, it } from "vitest"
import {
  checkBuild,
  checkContent,
  checkLinks,
  checkStructuredData,
  checkTypes,
  factsForContent,
  HIDDEN_FACTS_KEY,
  parsePage,
  runGates,
} from "../src/index.ts"

const ORG = "10000001-0000-4000-8000-000000000000"
const AT = "2026-09-15T12:00:00.000Z"
let n = 0
const fact = (
  key: string,
  value: unknown,
  source: FactRecord["provenance"]["source"] = "owner_stated"
): FactRecord => ({
  fact_id: `10000001-0000-4000-8000-${String(++n).padStart(12, "0")}`,
  org_id: ORG,
  key,
  fact_type: key.split(".")[0] ?? "x",
  value,
  version: 1,
  provenance: {
    source,
    confidence: 1,
    verified_by_staff_id: null,
    verified_at: null,
  },
  valid_from: AT,
  valid_to: null,
  superseded_by_fact_id: null,
})

const FACTS = [
  fact("business.name", { name: "BrightClean" }),
  fact("business.phone", { e164: "+15550142" }),
  fact("business.email", { address: "hello@brightclean.invalid" }),
  fact("hours.weekday", { open: "08:00", close: "17:00" }),
  fact("service_area.radius", { centre: "Fairhaven", radius_km: 25 }),
  fact("pricing.standard_clean_hourly", {
    currency: "USD",
    amount_minor: 3500,
  }),
]

const LD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  name: "BrightClean",
  telephone: "+15550142",
  email: "hello@brightclean.invalid",
})

const home = (
  main = "<p>$35 an hour</p><p>Weekdays 08:00 to 17:00</p>",
  ld = LD
) =>
  `<!doctype html><html lang="en"><head><title>BrightClean</title><script type="application/ld+json">${ld}</script></head><body><header><strong>BrightClean</strong><nav><a href="/">Home</a> <a href="/contact/">Contact</a></nav></header><main><h1>BrightClean</h1>${main}</main><footer><p>within 25 km of Fairhaven</p></footer></body></html>`

const contact = `<!doctype html><html lang="en"><head><title>Contact</title></head><body><main><h1>Contact</h1><p>Phone: <a href="tel:+15550142">+15550142</a></p><p>Email: <a href="mailto:hello@brightclean.invalid">hello@brightclean.invalid</a></p></main></body></html>`

const FILES = {
  "index.html": "x",
  "contact/index.html": "x",
  "_astro/site.css": "x",
}
const pages = (homeHtml = home()) => [
  parsePage("index.html", homeHtml),
  parsePage("contact/index.html", contact),
]

describe("the content gate", () => {
  it("passes a site whose every claim traces to a fact", () => {
    expect(checkContent(pages(), FACTS)).toMatchObject({
      gate: "content",
      passed: true,
    })
  })

  it("fails a fabricated price and names the node it sits in", () => {
    const result = checkContent(pages(home("<p>$49 an hour</p>")), FACTS)
    expect(result.passed).toBe(false)
    expect(result.offending_node).toMatch(/^index\.html html>body>main>p/)
    expect(result.message).toContain("$49")
  })

  it("fails an invented email, phone or closing time", () => {
    for (const main of [
      '<p><a href="mailto:sales@brightclean.invalid">sales@brightclean.invalid</a></p>',
      "<p>Call +1 555 0199</p>",
      "<p>Weekdays 08:00 to 18:00</p>",
    ]) {
      expect(checkContent(pages(home(main)), FACTS).passed, main).toBe(false)
    }
  })

  it("fails a claim in structured data too", () => {
    const ld = LD.replace("+15550142", "+15550199")
    const result = checkContent(pages(home(undefined, ld)), FACTS)
    expect(result.passed).toBe(false)
    expect(result.offending_node).toContain("script")
  })

  it("never lets an inferred fact support a claim", () => {
    const facts = [
      ...FACTS,
      fact("business.phone_alt", "+15550199", "inferred"),
    ]
    expect(factsForContent(facts)).toHaveLength(FACTS.length)
    expect(
      checkContent(pages(home("<p>Call +15550199</p>")), facts).passed
    ).toBe(false)
  })

  // ADR-033: what the owner left off the site is one fact whose value is fact
  // keys and no value of its own, so it supports no claim and decides nothing.
  it("is unchanged by the record of what the owner left off the site", () => {
    const facts = [
      ...FACTS,
      fact(HIDDEN_FACTS_KEY, ["pricing.standard_clean_hourly"]),
    ]
    const noPrice = pages(home("<p>Weekdays 08:00 to 17:00</p>"))
    expect(checkContent(noPrice, facts).passed).toBe(true)
    expect(checkContent(pages(), facts)).toEqual(checkContent(pages(), FACTS))
  })
})

describe("the structured data gate", () => {
  it("passes schema.org JSON-LD of an allowed type with its required properties", () => {
    expect(checkStructuredData(pages())).toMatchObject({
      gate: "structured_data",
      passed: true,
    })
  })

  it("fails JSON that does not parse, a missing context, an unknown type or a missing name", () => {
    for (const ld of [
      "{not json",
      JSON.stringify({ "@type": "LocalBusiness", name: "BrightClean" }),
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Casino",
        name: "BrightClean",
      }),
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "LocalBusiness",
      }),
    ]) {
      expect(checkStructuredData(pages(home(undefined, ld))).passed, ld).toBe(
        false
      )
    }
  })
})

describe("the links gate", () => {
  it("passes internal links that resolve through the manifest and leaves external ones unfetched", () => {
    const extra =
      '<p><a href="https://www.google.com/maps">Map</a> <a href="#hours">Hours</a></p>'
    expect(
      checkLinks(pages(home(`<p>$35 an hour</p>${extra}`)), FILES)
    ).toMatchObject({
      gate: "links",
      passed: true,
    })
  })

  it("fails a link to a page the build does not have, and a script link", () => {
    for (const main of [
      '<p><a href="/pricing/">Pricing</a></p>',
      '<p><a href="javascript:alert(1)">x</a></p>',
    ]) {
      const result = checkLinks(pages(home(main)), FILES)
      expect(result.passed, main).toBe(false)
      expect(result.offending_node).toContain("a")
    }
  })
})

describe("the build gate", () => {
  const body = new TextEncoder().encode("<h1>BrightClean</h1>")
  const sha = createHash("sha256").update(body).digest("hex")
  const manifest = (files: Record<string, string>) => ({
    revision_id: ORG,
    site_id: ORG,
    org_id: ORG,
    routes: [{ path: "/", file: "index.html" }],
    headers: {},
    files,
    built_at: AT,
  })
  const read = (present: Record<string, Uint8Array>) => async (file: string) =>
    present[file] ?? null

  it("passes when every listed file is there with its hash and the home page exists", async () => {
    expect(
      await checkBuild(
        manifest({ "index.html": sha }),
        read({ "index.html": body })
      )
    ).toMatchObject({
      gate: "build",
      passed: true,
    })
  })

  it("fails a missing file, a changed file, no home page, or a manifest that does not parse", async () => {
    expect(
      (await checkBuild(manifest({ "index.html": sha }), read({}))).passed
    ).toBe(false)
    expect(
      (
        await checkBuild(
          manifest({ "index.html": sha }),
          read({ "index.html": new TextEncoder().encode("changed") })
        )
      ).passed
    ).toBe(false)
    expect(
      (
        await checkBuild(
          manifest({ "about/index.html": sha }),
          read({ "about/index.html": body })
        )
      ).passed
    ).toBe(false)
    expect((await checkBuild({ nope: true }, read({}))).passed).toBe(false)
  })
})

describe("the types gate", () => {
  const report = (checks: CompletionReport["checks"]) =>
    ({ checks }) as CompletionReport

  it("takes the sandbox's astro check and says where it came from", () => {
    const ok = checkTypes(
      report([
        {
          check: "astro check",
          exit_code: 0,
          output_key: "sites/x/checks/check.log",
        },
      ])
    )
    expect(ok).toMatchObject({
      gate: "types",
      passed: true,
      evidence_key: "sites/x/checks/check.log",
    })
    expect(ok.message).toMatch(/sandbox/)
    expect(
      checkTypes(
        report([{ check: "astro check", exit_code: 1, output_key: null }])
      ).passed
    ).toBe(false)
    expect(
      checkTypes(
        report([{ check: "astro build", exit_code: 0, output_key: null }])
      ).passed
    ).toBe(false)
  })
})

describe("all the gates", () => {
  it("returns one contract-valid result per gate, in the contract's order", async () => {
    const body = new TextEncoder().encode(home())
    const contactBody = new TextEncoder().encode(contact)
    const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")
    const results = await runGates({
      manifest: {
        revision_id: ORG,
        site_id: ORG,
        org_id: ORG,
        routes: [],
        headers: {},
        files: {
          "index.html": hash(body),
          "contact/index.html": hash(contactBody),
        },
        built_at: AT,
      },
      read: async (file) =>
        file === "index.html"
          ? body
          : file === "contact/index.html"
            ? contactBody
            : null,
      report: {
        checks: [{ check: "astro check", exit_code: 0, output_key: null }],
      } as CompletionReport,
      facts: FACTS,
    })
    expect(results.map((r) => r.gate)).toEqual([
      "build",
      "types",
      "links",
      "structured_data",
      "content",
      "claims",
    ])
    for (const r of results) expect(GateResult.parse(r)).toEqual(r)
    expect(results.every((r) => r.passed)).toBe(true)
  })
})
