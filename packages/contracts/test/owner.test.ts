import { describe, expect, it } from "vitest"
import {
  ActivityFeed,
  AttentionItem,
  FactValue,
  GOAL_MAX,
  OwnerChangeRequest,
  PreviewLink,
  SetFactsRequest,
  WorkspaceStatus,
} from "../src/owner.ts"
import { ajv, generated } from "./json-schema.ts"
import { samples } from "./samples.ts"

// Every branch of the two owner unions, through Zod and through the published
// JSON Schema. The round-trip suite fuzzes one sample per contract; a union has
// a branch per kind, and a branch nobody parses is a branch nobody checked.

type Verdict = { zod: boolean; json: boolean }
const verdict = (
  name: string,
  schema: { safeParse: (v: unknown) => { success: boolean } },
  value: unknown
): Verdict => ({
  zod: schema.safeParse(value).success,
  json: ajv.validate(generated.components.schemas[name] as object, value),
})
const ACCEPTED: Verdict = { zod: true, json: true }
const REFUSED: Verdict = { zod: false, json: false }

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
