import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  COS_TOOLS,
  ConnectGoogleOutput,
  CosToolResult,
  GetIndexingInput,
  GetIndexingOutput,
  GetSearchPerformanceInput,
  GetSearchPerformanceOutput,
  GoogleConnectRequest,
  SearchConnection,
  SearchProperty,
  UrlStatus,
} from "../src/index.ts"
import { ACCEPTED, REFUSED, verdict } from "./json-schema.ts"
import { samples } from "./samples.ts"

/** Every property name anywhere in a JSON Schema. */
const keysOf = (node: unknown): string[] =>
  Array.isArray(node)
    ? node.flatMap(keysOf)
    : typeof node === "object" && node !== null
      ? Object.entries(node).flatMap(([k, v]) =>
          k === "properties" && typeof v === "object" && v !== null
            ? [...Object.keys(v), ...Object.values(v).flatMap(keysOf)]
            : keysOf(v)
        )
      : []

describe("what Search Console shows the model and the web app", () => {
  const shown = {
    connect_google: COS_TOOLS.connect_google.output,
    get_search_performance: COS_TOOLS.get_search_performance.output,
    get_indexing: COS_TOOLS.get_indexing.output,
    SearchConnection,
    SearchProperty,
  }

  // The refresh token, an access token, an org id or a Google account id
  // would each let a leaked output act as the owner's Google account.
  it.each(Object.entries(shown))("%s carries no secret or id", (_n, schema) => {
    const leaked = keysOf(z.toJSONSchema(schema)).filter((k) =>
      /token|secret|org_id|^id$|_id$|^sub$|verifier/i.test(k)
    )
    expect(leaked).toStrictEqual([])
  })
})

describe("GoogleConnectRequest", () => {
  const ok = samples.GoogleConnectRequest as Record<string, unknown>

  it("accepts the callback's three fields", () => {
    expect(verdict("GoogleConnectRequest", GoogleConnectRequest, ok)).toEqual(
      ACCEPTED
    )
  })

  it.each([
    ["an empty code", { ...ok, code: "" }],
    ["a code over 2048", { ...ok, code: "c".repeat(2049) }],
    ["a verifier under 43", { ...ok, verifier: "v".repeat(42) }],
    ["a verifier over 128", { ...ok, verifier: "v".repeat(129) }],
    ["a verifier with a space", { ...ok, verifier: `${"v".repeat(43)} ` }],
    ["no redirect_uri", { code: ok.code, verifier: ok.verifier }],
    ["a field of its own", { ...ok, org_id: "x" }],
  ])("refuses %s", (_name, body) => {
    expect(verdict("GoogleConnectRequest", GoogleConnectRequest, body)).toEqual(
      REFUSED
    )
  })
})

describe("connect_google", () => {
  it.each([
    ["a link", { url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" }],
    ["a connected account", { connected: true, email: "a@b.example" }],
    ["the feature off", { available: false }],
  ])("accepts %s", (_name, output) => {
    expect(verdict("ConnectGoogleOutput", ConnectGoogleOutput, output)).toEqual(
      ACCEPTED
    )
  })

  it.each([
    ["a link that is not https", { url: "http://accounts.google.com/" }],
    [
      "a link with a field beside it",
      { url: "https://x.example/", extra: "t" },
    ],
    ["connected: false", { connected: false, email: "a@b.example" }],
    ["available: true", { available: true }],
  ])("refuses %s", (_name, output) => {
    expect(verdict("ConnectGoogleOutput", ConnectGoogleOutput, output)).toEqual(
      REFUSED
    )
  })
})

describe("get_search_performance", () => {
  const out = samples.GetSearchPerformanceOutput as Record<string, unknown>

  it.each([7, 28, 90])("takes %i days", (days) => {
    const input = { days, by: "none" }
    expect(
      verdict("GetSearchPerformanceInput", GetSearchPerformanceInput, input)
    ).toEqual(ACCEPTED)
  })

  it.each([
    ["14 days", { days: 14, by: "none" }],
    ["a break-down of its own", { days: 7, by: "country" }],
    ["no break-down", { days: 7 }],
  ])("refuses %s", (_name, input) => {
    expect(
      verdict("GetSearchPerformanceInput", GetSearchPerformanceInput, input)
    ).toEqual(REFUSED)
  })

  it("accepts a first period with no change to report", () => {
    expect(
      verdict("GetSearchPerformanceOutput", GetSearchPerformanceOutput, {
        ...out,
        delta: null,
        rows: [],
      })
    ).toEqual(ACCEPTED)
  })

  it.each([
    ["21 rows", { ...out, rows: Array(21).fill((out.rows as object[])[0]) }],
    [
      "a rate over 1",
      { ...out, totals: { ...(out.totals as object), ctr: 2 } },
    ],
    ["a negative click count", { ...out, totals: { clicks: -1 } }],
    ["a date with a time", { ...out, as_of: "2026-10-15T00:00:00Z" }],
  ])("refuses %s", (_name, output) => {
    expect(
      verdict("GetSearchPerformanceOutput", GetSearchPerformanceOutput, output)
    ).toEqual(REFUSED)
  })
})

describe("get_indexing", () => {
  it.each([
    ["no url", {}],
    ["a page", { url: "https://brightclean.remeai.co.uk/" }],
  ])("takes %s", (_name, input) => {
    expect(verdict("GetIndexingInput", GetIndexingInput, input)).toEqual(
      ACCEPTED
    )
  })

  it.each([
    ["an http page", { url: "http://brightclean.remeai.co.uk/" }],
    ["a page with a space", { url: "https://a.example/x y" }],
    ["a property id", { property_id: "p" }],
  ])("refuses %s", (_name, input) => {
    expect(verdict("GetIndexingInput", GetIndexingInput, input)).toEqual(
      REFUSED
    )
  })

  it("accepts a site with no sitemap and no pages yet", () => {
    expect(
      verdict("GetIndexingOutput", GetIndexingOutput, {
        property: "pending",
        sitemap: null,
        pages: [],
      })
    ).toEqual(ACCEPTED)
  })

  it("refuses 51 pages", () => {
    const page = samples.UrlStatus
    expect(
      verdict("GetIndexingOutput", GetIndexingOutput, {
        property: "verified",
        sitemap: null,
        pages: Array(51).fill(page),
      })
    ).toEqual(REFUSED)
  })

  it("refuses a verdict Google does not give", () => {
    expect(
      verdict("UrlStatus", UrlStatus, {
        ...(samples.UrlStatus as object),
        verdict: "GREAT",
      })
    ).toEqual(REFUSED)
  })
})

describe("the public views", () => {
  it("shows a connection that was never completed", () => {
    expect(
      verdict("SearchConnection", SearchConnection, {
        state: "revoked",
        google_email: null,
        connected_at: null,
      })
    ).toEqual(ACCEPTED)
  })

  it("refuses a connection carrying a field of its own", () => {
    expect(
      verdict("SearchConnection", SearchConnection, {
        ...(samples.SearchConnection as object),
        sealed: "v1.a.b",
      })
    ).toEqual(REFUSED)
  })

  it("refuses a property carrying a field of its own", () => {
    expect(
      verdict("SearchProperty", SearchProperty, {
        ...(samples.SearchProperty as object),
        file: "google1a2b3c.html",
      })
    ).toEqual(REFUSED)
  })
})

describe("CosToolResult for the search tools", () => {
  it.each([
    ["connect_google", samples.ConnectGoogleOutput],
    ["get_search_performance", samples.GetSearchPerformanceOutput],
    ["get_indexing", samples.GetIndexingOutput],
  ])("carries %s's output", (tool, output) => {
    const result = {
      turn_id: "01JZ8QK5M7N9P0R2T4V6W8X0Y2",
      tool_call_id: "functions.x:0",
      tool,
      output,
    }
    expect(CosToolResult.safeParse(result).success).toBe(true)
    expect(
      CosToolResult.safeParse({ ...result, output: { available: true } })
        .success
    ).toBe(false)
  })
})
