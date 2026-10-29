import type { DerivedReminder, Reminder } from "@workspace/contracts"
import { expect, it } from "vitest"
import type { AttentionItem } from "./api/types"
import { groupReminders, noteOf, upcomingNotes } from "./reminders"

const note = (over: Partial<Reminder> = {}): Reminder => ({
  id: "7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d",
  title: "Order more microfibre cloths",
  // 23:30 UTC on 1 July is 00:30 on 2 July in London (summer time).
  due_at: "2026-07-01T23:30:00.000Z",
  done_at: null,
  source: "owner",
  conversation_id: null,
  created_at: "2026-06-30T09:00:00.000Z",
  updated_at: "2026-06-30T09:00:00.000Z",
  ...over,
})

/** Noon on Tuesday 30 June 2026, UTC. */
const NOW = new Date("2026-06-30T12:00:00.000Z")

it("shows a due time in the reader's zone, and none before the zone is known", () => {
  expect(noteOf(note(), "Europe/London", NOW).due).toBe("Thu 2 Jul, 12:30 AM")
  expect(noteOf(note(), "America/New_York", NOW).due).toBe("Tomorrow, 7:30 PM")
  // The server's render: no time at all, never a UTC one replaced later.
  expect(noteOf(note(), null, NOW).due).toBeNull()
  expect(noteOf(note({ due_at: null }), "Europe/London", NOW).due).toBeNull()
})

it("says today and tomorrow by the reader's calendar, not UTC's", () => {
  const at = (due_at: string) =>
    noteOf(note({ due_at }), "Australia/Sydney", NOW).due
  // Noon UTC is 10 pm in Sydney, so 14:30 UTC is already tomorrow there.
  expect(at("2026-06-30T14:30:00.000Z")).toBe("Tomorrow, 12:30 AM")
  expect(at("2026-06-30T12:30:00.000Z")).toBe("Today, 10:30 PM")
})

it("marks a reminder due within the hour, once the zone is known", () => {
  const soon = note({ due_at: "2026-06-30T12:45:00.000Z" })
  expect(noteOf(soon, "Europe/London", NOW).soon).toBe(true)
  expect(noteOf(soon, null, NOW).soon).toBe(false)
  expect(noteOf(note(), "Europe/London", NOW).soon).toBe(false)
  expect(noteOf(note({ due_at: null }), "Europe/London", NOW).soon).toBe(false)
})

it("lists only reminders still ahead, undated ones after, in the api's order", () => {
  const past = note({ id: "past", due_at: "2026-06-30T11:00:00.000Z" })
  const next = note({ id: "next", due_at: "2026-06-30T13:00:00.000Z" })
  const later = note({ id: "later" })
  const undated = note({ id: "undated", due_at: null })
  expect(
    upcomingNotes([past, next, later, undated], NOW.getTime()).map(
      (each) => each.id
    )
  ).toEqual(["next", "later", "undated"])
})

it("names the Chief of Staff only on its own reminders", () => {
  expect(noteOf(note({ source: "assistant" }), null).byAssistant).toBe(true)
  expect(noteOf(note(), null).byAssistant).toBe(false)
})

it("marks a reminder overdue once its time has passed, never also soon", () => {
  const past = noteOf(
    note({ due_at: "2026-06-30T11:00:00.000Z" }),
    "Europe/London",
    NOW
  )
  expect(past).toMatchObject({ overdue: true, soon: false })
  expect(noteOf(note(), "Europe/London", NOW).overdue).toBe(false)
  expect(
    noteOf(note({ due_at: "2026-06-30T11:00:00.000Z" }), null, NOW).overdue
  ).toBe(false)
})

const ids = (value: ReturnType<typeof groupReminders>) =>
  value.groups.map((group) => [group.id, group.notes.map((each) => each.id)])

it("groups written reminders by the reader's calendar, around midnight", () => {
  // Noon UTC is 10 pm in Sydney: 13:59 UTC is still today there, 14:00 is
  // tomorrow, and 11:00 UTC has passed.
  const notes = [
    note({ id: "past", due_at: "2026-06-30T11:00:00.000Z" }),
    note({ id: "tonight", due_at: "2026-06-30T13:59:00.000Z" }),
    note({ id: "midnight", due_at: "2026-06-30T14:00:00.000Z" }),
    note({ id: "undated", due_at: null }),
  ]
  expect(
    ids(groupReminders(notes, [], [], "Australia/Sydney", "Ellie", NOW))
  ).toEqual([
    ["overdue", ["past"]],
    ["today", ["tonight"]],
    ["upcoming", ["midnight"]],
    ["undated", ["undated"]],
  ])
  // In London the same instants all fall on the same day, 30 June.
  expect(
    ids(groupReminders(notes, [], [], "Europe/London", "Ellie", NOW))
  ).toEqual([
    ["overdue", ["past"]],
    ["today", ["tonight", "midnight"]],
    ["undated", ["undated"]],
  ])
})

it("keeps dated reminders in one group until the zone is known", () => {
  const notes = [
    note({ id: "past", due_at: "2026-06-30T11:00:00.000Z" }),
    note({ id: "later" }),
    note({ id: "undated", due_at: null }),
  ]
  expect(ids(groupReminders(notes, [], [], null, "Ellie", NOW))).toEqual([
    ["dated", ["past", "later"]],
    ["undated", ["undated"]],
  ])
})

it("has no groups at all with nothing to show", () => {
  expect(groupReminders([], [], [], "Europe/London", "Ellie", NOW)).toEqual({
    needed: [],
    groups: [],
  })
})

const APPROVAL = "4d5e6f70-8192-4d8e-af10-4b5c6d7e8f90"
const REQUEST = "5e6f7081-92a3-4e0f-8021-5c6d7e8f9001"
const BUILD = "6f708192-a3b4-4f10-9132-6d7e8f900112"

it("words each rule and points it where it is acted on", () => {
  const derived: DerivedReminder[] = [
    {
      rule: "approval_expiring",
      approval_id: APPROVAL,
      version: 4,
      expires_at: "2026-06-30T15:30:00.000Z",
    },
    { rule: "question_waiting", request_id: REQUEST },
    { rule: "preview_unpublished", assignment_id: BUILD, version: 5 },
    { rule: "facts_missing", keys: ["business.phone"] },
  ]
  const attention = [
    {
      kind: "question",
      id: REQUEST,
      raisedBy: "The Developer",
      title: "Weekday hours",
    },
  ] as unknown as AttentionItem[]
  const { needed } = groupReminders(
    [],
    derived,
    attention,
    "Europe/London",
    "Ellie",
    NOW
  )
  expect(needed).toEqual([
    {
      key: `approval-${APPROVAL}`,
      title: "Your website is ready to publish",
      detail: "Publish by today, 4:30 PM.",
      action: {
        label: "Review and publish",
        focus: `approval-${APPROVAL}`,
      },
    },
    {
      key: `question-${REQUEST}`,
      title: "Ellie asked about weekday hours",
      detail: "Waiting for over 12 hours.",
      action: { label: "Show the question", focus: `question-${REQUEST}` },
    },
    {
      key: `build-${BUILD}`,
      title: "Your changes aren't published yet",
      detail: "Ready for over 12 hours.",
      action: { label: "Open in the panel", focus: `build-${BUILD}` },
    },
    {
      key: "facts",
      title: "Ellie still needs your phone number",
      detail: "Your website uses these. Tell Ellie in a chat.",
      action: { label: "Tell Ellie", chat: true },
    },
  ])
  // An owner who has not named the assistant is told "your assistant".
  const unnamed = groupReminders(
    [],
    derived.slice(3),
    [],
    null,
    "your assistant",
    NOW
  )
  expect(unnamed.needed[0]?.title).toBe(
    "Your assistant still needs your phone number"
  )
  expect(unnamed.needed[0]?.action.label).toBe("Tell your assistant")
  // No time before the zone is known, and a question the panel lacks.
  const bare = groupReminders(
    [],
    derived.slice(0, 2),
    [],
    null,
    "Ellie",
    NOW
  ).needed
  expect(bare.map((each) => [each.title, each.detail])).toEqual([
    ["Your website is ready to publish", "Publish within a day."],
    ["A question is waiting for your answer", "Waiting for over 12 hours."],
  ])
})
