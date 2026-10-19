import { describe, expect, it } from "vitest"
import { PALETTES } from "../src/onboarding.ts"
import {
  ActivityFeed,
  AttentionItem,
  CreateReminderRequest,
  DerivedReminder,
  FactValue,
  FactValueKey,
  GOAL_MAX,
  OWNER_BRIDGE_HEADERS,
  OwnerAnswerText,
  OwnerChangeRequest,
  PreviewLink,
  REMINDER_NOTES_MAX,
  Reminder,
  ReminderPatch,
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
  reminder: { kind: "reminder", reminder: samples.Reminder },
}

const facts = {
  "business.name": { name: "Brightclean Cleaning Co. (fixture)" },
  "business.phone": { e164: "+15550142" },
  "business.email": { address: "hello@brightclean.invalid" },
  "hours.weekday": { open: "08:00", close: "17:30" },
  "service_area.radius": { centre: "Fairhaven", radius_km: 25 },
  "business.tagline": { tagline: "Cleaning you can plan your week around" },
  "business.industry": {
    name: "Limousine and chauffeur hire",
    category: "chauffeur",
  },
  "business.offerings": { items: ["Airport transfers", "Wedding hire"] },
  "business.audience": {
    text: "Couples, corporate travellers and event planners",
  },
  "business.overview": {
    text: "Six cars, eight chauffeurs, bookings by phone or email",
  },
  "business.proof": {
    text: "Trading since 2009, fully insured, every driver DBS checked",
  },
  "business.disclaimer": {
    text: "Authorised and regulated by the Fairhaven Law Society. Reg. 4471.",
  },
  "service_area.text": { text: "Greater Fairhaven and the airports" },
  "assistant.name": { name: "Sam" },
  "assistant.pronouns": { id: "she_her" },
  "assistant.tone": { id: "friendly" },
  "owner.preferred_name": { name: "Jo" },
  "site.build_mode": { mode: "assistant" },
  "site.template": { id: "classic", custom: "A bit more like a magazine" },
  "site.palette": { id: "ocean" },
  "site.font": { id: "custom", custom: "Something like a newspaper headline" },
  "site.direction": { id: "calm_daylight" },
  "site.pages": { ids: ["home", "services", "quote"] },
  "quote.form": {
    fields: [
      {
        key: "pickup",
        label: "Pick-up address",
        type: "text",
        required: true,
        hint: null,
        options: null,
      },
      {
        key: "passengers",
        label: "Number of passengers",
        type: "number",
        required: true,
        hint: null,
        options: null,
      },
    ],
  },
  "media.uploads": {
    items: [
      {
        id: "8d9e0f10-2131-4a2b-9c3d-4e5f60718293",
        name: "fleet-front.jpg",
        content_type: "image/jpeg",
        bytes: 482113,
      },
    ],
  },
  "testimonials.review_1": {
    quote: "Never late, and the car was spotless.",
    name: "Priya S.",
    permission: true,
  },
  "testimonials.review_2": {
    quote: "They waited forty minutes for a delayed flight without a word.",
    name: "Tom",
    permission: true,
  },
}

describe("AttentionItem", () => {
  it("has a case here for exactly the five kinds: §7.3's four and a due reminder", () => {
    const kinds = AttentionItem.options.map((o) => o.shape.kind.value)
    expect(new Set(kinds)).toEqual(new Set(Object.keys(attention)))
  })

  it.each(Object.entries(attention))("accepts a %s", (_kind, item) => {
    expect(verdict("AttentionItem", AttentionItem, item)).toEqual(ACCEPTED)
  })

  const refused: [string, unknown][] = [
    ["a sixth kind", { ...attention.report, kind: "note" }],
    ["a reminder with no row", { kind: "reminder" }],
    [
      "a reminder carrying a bare id",
      { kind: "reminder", reminder_id: "8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e" },
    ],
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
    expect(new Set(keys)).toEqual(new Set(Object.keys(facts)))
  })

  it.each(Object.entries(facts))("accepts %s", (key, value) => {
    expect(verdict("FactValue", FactValue, { key, value })).toEqual(ACCEPTED)
  })

  const refused: [string, unknown][] = [
    ["an unknown key", { key: "business.fax", value: { e164: "+15550142" } }],
    [
      "a review the customer did not agree to",
      {
        key: "testimonials.review_1",
        value: { ...facts["testimonials.review_1"], permission: false },
      },
    ],
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
  it("holds a palette to a preset alone, or custom with words or a colour", () => {
    const PALETTE = "site.palette"
    const brand = PALETTES[0]?.brand
    for (const value of [
      { id: "custom", custom: "Navy and gold" },
      { id: "custom", brand },
      { id: "custom", custom: "Like the sea", brand },
    ]) {
      expect(verdict("FactValue", FactValue, { key: PALETTE, value })).toEqual(
        ACCEPTED
      )
    }
    for (const value of [
      { id: "custom" },
      { id: "ocean", brand },
      { id: "ocean", custom: "but darker" },
    ]) {
      expect(verdict("FactValue", FactValue, { key: PALETTE, value })).toEqual({
        zod: false,
        json: true,
      })
    }
    expect(
      verdict("FactValue", FactValue, {
        key: PALETTE,
        value: { id: "custom", brand: brand?.slice(1) },
      })
    ).toEqual(REFUSED)
  })

  it("takes a font pair id and a design direction, and refuses a made-up font", () => {
    const check = (key: string, value: unknown) =>
      verdict("FactValue", FactValue, { key, value })
    expect(check("site.font", { id: "sora_manrope" })).toEqual(ACCEPTED)
    expect(check("site.font", { id: "clean_sans" })).toEqual(ACCEPTED)
    expect(check("site.font", { id: "comic_sans" })).toEqual(REFUSED)
    expect(check("site.direction", { id: "calm_daylight" })).toEqual(ACCEPTED)
    expect(
      check("site.direction", { id: "custom", custom: "Navy and gold" })
    ).toEqual(ACCEPTED)
    expect(check("site.direction", { id: "builder" })).toEqual(ACCEPTED)
    expect(check("site.direction", { id: "Calm Daylight" })).toEqual(REFUSED)
  })

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

  it("names the build behind the live version, so its screenshots can be read", () => {
    const sample = samples.WorkspaceStatus as {
      site: { host: string; live: Record<string, unknown> }
    }
    const live = (value: unknown) =>
      verdict("WorkspaceStatus", WorkspaceStatus, {
        ...sample,
        site: { ...sample.site, live: value },
      })
    const { assignment_id: _, ...unnamed } = sample.site.live
    expect(live(sample.site.live)).toEqual(ACCEPTED)
    expect(live(null)).toEqual(ACCEPTED)
    expect(live(unnamed)).toEqual(REFUSED)
    expect(live({ ...sample.site.live, assignment_id: "a1" })).toEqual(REFUSED)
  })

  it("links a preview over https, or http on a .localhost host, with exactly three screenshots", () => {
    const link = samples.PreviewLink as { screenshots: string[] }
    const local = "http://preview-v1-brightclean.reme.localhost:3004"
    expect(
      verdict("PreviewLink", PreviewLink, {
        ...link,
        url: `${local}/open?t=abc.def`,
        screenshots: link.screenshots.map((_, i) => `${local}/s${i}.png?t=x`),
      })
    ).toEqual(ACCEPTED)
    for (const url of [
      "http://example.invalid/open",
      "http://brightclean.localhost.evil.com/open",
      "http://evil.com/x.localhost",
      "http://user@evil.com:80/.localhost",
      "javascript:alert(1)",
    ]) {
      expect(
        verdict("PreviewLink", PreviewLink, { ...link, url }),
        url
      ).toEqual(REFUSED)
      expect(
        verdict("PreviewLink", PreviewLink, {
          ...link,
          screenshots: [url, ...link.screenshots.slice(1)],
        }),
        url
      ).toEqual(REFUSED)
    }
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
      "business.tagline",
      "business.industry",
      "business.offerings",
      "business.audience",
      "business.overview",
      "business.proof",
      "business.disclaimer",
      "service_area.text",
      "assistant.name",
      "assistant.pronouns",
      "assistant.tone",
      "owner.preferred_name",
      "site.build_mode",
      "site.template",
      "site.palette",
      "site.font",
      "site.direction",
      "site.pages",
      "media.uploads",
      "quote.form",
      "testimonials.review_1",
      "testimonials.review_2",
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

describe("Reminder", () => {
  const note = samples.Reminder as Record<string, unknown>

  it("takes a 200-character title and refuses 201 or a blank one", () => {
    const titled = (title: string) => ({ ...note, title })
    expect(verdict("Reminder", Reminder, titled("a".repeat(200)))).toEqual(
      ACCEPTED
    )
    expect(verdict("Reminder", Reminder, titled("a".repeat(201)))).toEqual(
      REFUSED
    )
    expect(verdict("Reminder", Reminder, titled(" \n "))).toEqual(REFUSED)
  })

  it("comes from the owner or the assistant only", () => {
    const from = (source: string) => ({ ...note, source })
    expect(verdict("Reminder", Reminder, from("owner"))).toEqual(ACCEPTED)
    expect(verdict("Reminder", Reminder, from("developer"))).toEqual(REFUSED)
  })
})

describe("the reminder requests", () => {
  const create = samples.CreateReminderRequest as Record<string, unknown>

  it.each([
    ["an undated reminder", { ...create, due_at: null }],
    ["a 200-character title", { ...create, title: "a".repeat(200) }],
  ])("creates %s", (_name, body) => {
    expect(
      verdict("CreateReminderRequest", CreateReminderRequest, body)
    ).toEqual(ACCEPTED)
  })

  // The route decides the source; a caller cannot claim one.
  it.each([
    ["a source", { ...create, source: "assistant" }],
    ["no due_at at all", { title: create.title }],
    ["a 201-character title", { ...create, title: "a".repeat(201) }],
    ["a blank title", { ...create, title: "  " }],
    ["a due time with no offset", { ...create, due_at: "2026-08-27T09:30" }],
  ])("refuses %s", (_name, body) => {
    expect(
      verdict("CreateReminderRequest", CreateReminderRequest, body)
    ).toEqual(REFUSED)
  })

  it("patches done and nothing else", () => {
    const patch = (body: unknown) =>
      verdict("ReminderPatch", ReminderPatch, body)
    expect(patch({ done: false })).toEqual(ACCEPTED)
    expect(patch({})).toEqual(REFUSED)
    expect(patch({ done: "yes" })).toEqual(REFUSED)
    expect(patch({ done: true, title: "Renamed" })).toEqual(REFUSED)
  })
})

describe("DerivedReminder", () => {
  const derived = (
    samples.WorkspaceStatus as {
      reminders: { derived: { rule: string }[] }
    }
  ).reminders.derived
  const byRule = Object.fromEntries(derived.map((d) => [d.rule, d]))

  it("has a case here for exactly the four rules", () => {
    const rules = DerivedReminder.options.map((o) => o.shape.rule.value)
    expect(new Set(rules)).toEqual(new Set(Object.keys(byRule)))
  })

  it.each(derived.map((d) => [d.rule, d]))("accepts %s", (_rule, item) => {
    expect(verdict("DerivedReminder", DerivedReminder, item)).toEqual(ACCEPTED)
  })

  it.each([
    ["a fifth rule", { ...byRule.question_waiting, rule: "stale_site" }],
    ["copy", { ...byRule.question_waiting, message: "Answer this" }],
    ["a done state", { ...byRule.question_waiting, done_at: null }],
    ["an id of its own", { ...byRule.question_waiting, id: ASSIGNMENT }],
    [
      "an expiring approval with no expiry",
      { ...byRule.approval_expiring, expires_at: undefined },
    ],
    ["no missing keys", { rule: "facts_missing", keys: [] }],
    ["a key the owner cannot state", { rule: "facts_missing", keys: ["x"] }],
  ])("refuses %s", (_name, item) => {
    expect(verdict("DerivedReminder", DerivedReminder, item)).toEqual(REFUSED)
  })
})

describe("WorkspaceStatus reminders", () => {
  const status = samples.WorkspaceStatus as {
    reminders: { notes: unknown[]; derived: unknown[] }
  }
  const withNotes = (n: number) => ({
    ...status,
    reminders: {
      ...status.reminders,
      notes: Array(n).fill(status.reminders.notes[0]),
    },
  })

  it("lists at most REMINDER_NOTES_MAX open notes", () => {
    expect(REMINDER_NOTES_MAX).toBe(20)
    expect(
      verdict("WorkspaceStatus", WorkspaceStatus, withNotes(REMINDER_NOTES_MAX))
    ).toEqual(ACCEPTED)
    expect(
      verdict(
        "WorkspaceStatus",
        WorkspaceStatus,
        withNotes(REMINDER_NOTES_MAX + 1)
      )
    ).toEqual(REFUSED)
  })

  it("always answers with reminders, even when there are none", () => {
    const { reminders: _, ...without } = status
    expect(verdict("WorkspaceStatus", WorkspaceStatus, without)).toEqual(
      REFUSED
    )
    expect(
      verdict("WorkspaceStatus", WorkspaceStatus, {
        ...status,
        reminders: { notes: [], derived: [] },
      })
    ).toEqual(ACCEPTED)
  })
})

describe("the onboarding presets", () => {
  it("has a palette entry for every palette id and nothing else", async () => {
    const { PaletteId } = await import("../src/onboarding.ts")
    expect(PALETTES.map((p) => p.id)).toEqual(PaletteId.options)
    for (const palette of PALETTES) {
      expect(palette.swatches).toEqual([
        palette.paper,
        palette.tint,
        palette.primary,
        palette.ink,
      ])
      expect(palette.brand).toBe(palette.primary)
    }
    // No two presets share a brand colour.
    expect(new Set(PALETTES.map((p) => p.brand)).size).toBe(PALETTES.length)
  })
})
