import type { Reminder } from "@workspace/contracts"
import { expect, it } from "vitest"
import { noteOf, upcomingNotes } from "./reminders"

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
  expect(noteOf(note(), "Europe/London", NOW).due).toBe("Thu 2 Jul, 12:30 am")
  expect(noteOf(note(), "America/New_York", NOW).due).toBe("Tomorrow, 7:30 pm")
  // The server's render: no time at all, never a UTC one replaced later.
  expect(noteOf(note(), null, NOW).due).toBeNull()
  expect(noteOf(note({ due_at: null }), "Europe/London", NOW).due).toBeNull()
})

it("says today and tomorrow by the reader's calendar, not UTC's", () => {
  const at = (due_at: string) =>
    noteOf(note({ due_at }), "Australia/Sydney", NOW).due
  // Noon UTC is 10 pm in Sydney, so 14:30 UTC is already tomorrow there.
  expect(at("2026-06-30T14:30:00.000Z")).toBe("Tomorrow, 12:30 am")
  expect(at("2026-06-30T12:30:00.000Z")).toBe("Today, 10:30 pm")
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
