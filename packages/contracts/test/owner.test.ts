import { describe, expect, it } from "vitest"
import {
  ActivityFeed,
  AttentionItem,
  FactValue,
  FactValueKey,
  GOAL_MAX,
  OWNER_BRIDGE_HEADERS,
  OwnerAnswerText,
  OwnerChangeRequest,
  PreviewLink,
  SetFactsRequest,
  TextAnswerSchema,
  WorkspaceStatus,
} from "../src/owner.ts"
import { ACCEPTED, REFUSED, verdict } from "./json-schema.ts"
import { samples } from "./samples.ts"

// Every branch of the two owner unions, through Zod and through the published
// JSON Schema. The round-trip suite fuzzes one sample per contract; a union has
// a branch per kind, and a branch nobody parses is a branch nobody checked.

const ULID = "01JZ8QK5M7N9P0R2T4V6W8X0Y2"
const ASSIGNMENT = "3c4d5e6f-7081-4c8d-9e0f-3a4b5c6d7e8f"
const REVISION = "6f708192-a3b4-4f80-8132-6d7e8f900112"
const NOW = "2026-08-26T09:30:00Z"
const revision = { revision_id: REVISION, version: 3 }

const attention = {
  question: { kind: "question", request: samples.InformationRequest },
  approval: { kind: "approval", request: samples.ApprovalRequest, version: 3 },
  report: {
    kind: "report",
    event_id: ULID,
    assignment_id: ASSIGNMENT,
    at: NOW,
    what: "published",
    revision,
  },
  alert: {
    kind: "alert",
    event_id: ULID,
    assignment_id: null,
    at: NOW,
    reason: "build_failed",
  },
}

const facts = {
  "business.name": { name: "Brightclean Cleaning Co. (fixture)" },
  "business.phone": { e164: "+15550142" },
  "business.email": { address: "hello@brightclean.invalid" },
  "hours.weekday": { open: "08:00", close: "17:30" },
  "service_area.radius": { centre: "Fairhaven", radius_km: 25 },
  "pricing.standard_clean_hourly": { amount_minor: 3500, currency: "GBP" },
  "business.tagline": { tagline: "Cleaning you can plan your week around" },
}

describe("AttentionItem", () => {
  it("has a case here for exactly the four kinds of §7.3", () => {
    const kinds = AttentionItem.options.map((o) => o.shape.kind.value)
    expect(kinds.sort()).toEqual(Object.keys(attention).sort())
  })

  it.each(Object.entries(attention))("accepts a %s", (_kind, item) => {
    expect(verdict("AttentionItem", AttentionItem, item)).toEqual(ACCEPTED)
  })

  const refused: [string, unknown][] = [
    ["a fifth kind", { ...attention.report, kind: "reminder" }],
    [
      "a question carrying an approval",
      { kind: "question", request: samples.ApprovalRequest },
    ],
    [
      "an approval without the version it binds",
      { kind: "approval", request: samples.ApprovalRequest },
    ],
    ["a report of anything but a publish", { ...attention.report, what: "x" }],
    ["an alert with an unknown reason", { ...attention.alert, reason: "x" }],
    ["an alert carrying copy", { ...attention.alert, message: "Oh no" }],
    ["a report with no revision", { ...attention.report, revision: null }],
    ["a malformed event id", { ...attention.alert, event_id: "evt_1" }],
  ]
  it.each(refused)("refuses %s", (_name, item) => {
    expect(verdict("AttentionItem", AttentionItem, item)).toEqual(REFUSED)
  })
})

describe("FactValue", () => {
  it("has a case here for every key it knows, and only those", () => {
    const keys = FactValue.options.map((o) => o.shape.key.value)
    expect(keys.sort()).toEqual(Object.keys(facts).sort())
  })

  it.each(Object.entries(facts))("accepts %s", (key, value) => {
    expect(verdict("FactValue", FactValue, { key, value })).toEqual(ACCEPTED)
  })

  const refused: [string, unknown][] = [
    ["an unknown key", { key: "business.fax", value: { e164: "+15550142" } }],
    [
      "another key's value",
      { key: "business.name", value: facts["business.phone"] },
    ],
    [
      "a phone that is not E.164",
      { key: "business.phone", value: { e164: "0555 0142" } },
    ],
    [
      "an address that is not one",
      { key: "business.email", value: { address: "hello at brightclean" } },
    ],
    [
      "an hour past 23",
      { key: "hours.weekday", value: { open: "08:00", close: "24:00" } },
    ],
    [
      "an hour without minutes",
      { key: "hours.weekday", value: { open: "8", close: "17:00" } },
    ],
    [
      "a zero radius",
      {
        key: "service_area.radius",
        value: { centre: "Fairhaven", radius_km: 0 },
      },
    ],
    [
      "a fractional minor amount",
      {
        key: "pricing.standard_clean_hourly",
        value: { amount_minor: 35.5, currency: "GBP" },
      },
    ],
    [
      "a currency the content gate cannot verify",
      {
        key: "pricing.standard_clean_hourly",
        value: { amount_minor: 3500, currency: "JPY" },
      },
    ],
    [
      "an extra field in the value",
      { key: "business.name", value: { name: "Brightclean", legal: "Ltd" } },
    ],
    ["an empty name", { key: "business.name", value: { name: "" } }],
    ["a blank name", { key: "business.name", value: { name: "   " } }],
    [
      "a blank centre",
      { key: "service_area.radius", value: { centre: "\t", radius_km: 5 } },
    ],
    ["a blank tagline", { key: "business.tagline", value: { tagline: " " } }],
    ["a bare value", { key: "business.name", value: "Brightclean" }],
  ]
  it.each(refused)("refuses %s", (_name, fact) => {
    expect(verdict("FactValue", FactValue, fact)).toEqual(REFUSED)
  })

  // JSON Schema cannot compare two properties, so only Zod holds this rule.
  // Every writer (api, orchestrator, web) parses with Zod.
  const HOURS = "hours.weekday"
  it("refuses hours that close before or as they open, or past midnight", () => {
    for (const value of [
      { open: "17:30", close: "08:00" },
      { open: "09:00", close: "09:00" },
      { open: "22:00", close: "02:00" },
    ]) {
      expect(verdict("FactValue", FactValue, { key: HOURS, value })).toEqual({
        zod: false,
        json: true,
      })
      expect(FactValue.safeParse({ key: HOURS, value }).error?.issues).toEqual([
        expect.objectContaining({
          code: "custom",
          path: ["value", "close"],
          message: "close must be later than open on the same day",
        }),
      ])
    }
  })

  it("takes a close of 00:00 as the end of the day, after any opening", () => {
    for (const open of ["18:00", "23:59", "00:00"]) {
      expect(
        verdict("FactValue", FactValue, {
          key: HOURS,
          value: { open, close: "00:00" },
        })
      ).toEqual(ACCEPTED)
    }
  })

  it("says only what is wrong with a time that is not HH:MM", () => {
    for (const value of [
      { open: "25:00", close: "08:00" },
      { open: "8", close: "17:00" },
    ]) {
      expect(FactValue.safeParse({ key: HOURS, value }).error?.issues).toEqual([
        expect.objectContaining({
          code: "invalid_format",
          path: ["value", "open"],
        }),
      ])
    }
  })
})

describe("the requests around them", () => {
  it("takes from one fact to as many as there are keys", () => {
    const one = { key: "business.name", value: facts["business.name"] }
    const keys = FactValue.options.length
    expect(verdict("SetFactsRequest", SetFactsRequest, { facts: [] })).toEqual(
      REFUSED
    )
    expect(
      verdict("SetFactsRequest", SetFactsRequest, {
        facts: Array(keys).fill(one),
      })
    ).toEqual(ACCEPTED)
    expect(
      verdict("SetFactsRequest", SetFactsRequest, {
        facts: Array(keys + 1).fill(one),
      })
    ).toEqual(REFUSED)
  })

  it("caps a change request at the goal limit the orchestrator enforces", () => {
    expect(GOAL_MAX).toBe(4000)
    const at = { text: "a".repeat(GOAL_MAX) }
    const over = { text: "a".repeat(GOAL_MAX + 1) }
    expect(verdict("OwnerChangeRequest", OwnerChangeRequest, at)).toEqual(
      ACCEPTED
    )
    expect(verdict("OwnerChangeRequest", OwnerChangeRequest, over)).toEqual(
      REFUSED
    )
    const blank = { text: " \n\t " }
    expect(verdict("OwnerChangeRequest", OwnerChangeRequest, blank)).toEqual(
      REFUSED
    )
  })

  it("lists only reports and alerts as activity", () => {
    const feed = (item: unknown) =>
      verdict("ActivityFeed", ActivityFeed, { items: [item] })
    expect(feed(attention.report)).toEqual(ACCEPTED)
    expect(feed(attention.alert)).toEqual(ACCEPTED)
    expect(feed(attention.question)).toEqual(REFUSED)
    expect(feed(attention.approval)).toEqual(REFUSED)
  })

  it("names a missing fact only by a key the owner can state", () => {
    const status = (missing_facts: string[]) =>
      verdict("WorkspaceStatus", WorkspaceStatus, {
        ...(samples.WorkspaceStatus as object),
        missing_facts,
      })
    expect(status(["business.email", "hours.weekday"])).toEqual(ACCEPTED)
    expect(status(["site.hidden_facts"])).toEqual(REFUSED)
  })

  it("links a preview over https only, with exactly three screenshots", () => {
    const link = samples.PreviewLink as { screenshots: string[] }
    expect(
      verdict("PreviewLink", PreviewLink, {
        ...link,
        url: "http://example.invalid/open",
      })
    ).toEqual(REFUSED)
    expect(
      verdict("PreviewLink", PreviewLink, {
        ...link,
        screenshots: link.screenshots.slice(1),
      })
    ).toEqual(REFUSED)
  })
})

describe("the bridge's building blocks", () => {
  it("names every FactValue key and nothing else", () => {
    expect(FactValueKey.options).toEqual([
      "business.name",
      "business.phone",
      "business.email",
      "hours.weekday",
      "service_area.radius",
      "pricing.standard_clean_hourly",
      "business.tagline",
    ])
    expect(FactValueKey.safeParse("business.fax").success).toBe(false)
  })

  it("takes an answer with something in it, up to 500 characters", () => {
    expect(OwnerAnswerText.safeParse("On the street").success).toBe(true)
    expect(OwnerAnswerText.safeParse("x".repeat(500)).success).toBe(true)
    for (const bad of ["", "   ", "x".repeat(501), 123]) {
      expect(OwnerAnswerText.safeParse(bad).success).toBe(false)
    }
  })

  it("takes a text answer schema of type, length and email format only", () => {
    const check = (value: unknown) =>
      verdict("TextAnswerSchema", TextAnswerSchema, value)
    for (const good of [
      { type: "string" },
      { type: "string", maxLength: 1 },
      { type: "string", maxLength: 500, format: "email" },
    ]) {
      expect(check(good)).toEqual(ACCEPTED)
    }
    for (const bad of [
      {},
      { type: "object", properties: { email: { type: "string" } } },
      { type: "string", maxLength: 0 },
      { type: "string", maxLength: 501 },
      { type: "string", maxLength: 1.5 },
      { type: "string", format: "uri" },
      // A model-written regex is a ReDoS risk; options cover enums.
      { type: "string", pattern: "^(a+)+$" },
      { type: "string", enum: ["Yes", "No"] },
      { type: "string", minLength: 1 },
    ]) {
      expect(check(bad)).toEqual(REFUSED)
    }
  })

  it("names three distinct lowercase headers", () => {
    const names = Object.values(OWNER_BRIDGE_HEADERS)
    expect(new Set(names).size).toBe(3)
    for (const n of names) expect(n).toMatch(/^x-reme-[a-z-]+$/)
  })
})
