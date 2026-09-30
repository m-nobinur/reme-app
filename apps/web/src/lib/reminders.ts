import type {
  DerivedReminder,
  FactValueKey,
  Reminder,
} from "@workspace/contracts"
import { factLabel } from "@workspace/ui/lib/facts"
import type { AttentionItem } from "./api/types"

/**
 * Reminders in the owner's words: the derived ones for the briefing, from
 * the facts the api sends and the rows the workspace already holds, and the
 * written ones as the panel lists them.
 */

type Rule<Name extends DerivedReminder["rule"]> = Extract<
  DerivedReminder,
  { rule: Name }
>

/** The element id of each panel item a reminder can point at. */
export const anchorOf = {
  approval: (id: string) => `approval-${id}`,
  question: (id: string) => `question-${id}`,
  build: (assignmentId: string) => `build-${assignmentId}`,
}

/** `your phone number and weekday hours`. */
export const factsNeeded = (keys: FactValueKey[]) =>
  `your ${new Intl.ListFormat("en-GB").format(
    keys.map((key) => factLabel(key).toLowerCase())
  )}`

/** The question a `question_waiting` reminder is about, if the panel has it. */
export const questionOf = (
  attention: AttentionItem[],
  reminder: Rule<"question_waiting">
) =>
  attention.find(
    (item): item is Extract<AttentionItem, { kind: "question" }> =>
      item.kind === "question" && item.id === reminder.request_id
  )

/** The calendar day `at` falls on in `zone`, as a day count to compare. */
const dayOf = (at: Date, zone: string) =>
  Date.parse(at.toLocaleDateString("en-CA", { timeZone: zone })) / 86_400_000

/** `Today, 4:30 pm`, `Tomorrow, 9:00 am`, else `Fri 3 Oct, 9:00 am`, in `zone`. */
export function dueLine(at: string, zone: string, now = new Date()): string {
  const date = new Date(at)
  const days = dayOf(date, zone) - dayOf(now, zone)
  const day =
    days === 0
      ? "Today"
      : days === 1
        ? "Tomorrow"
        : date.toLocaleDateString("en-GB", {
            weekday: "short",
            day: "numeric",
            month: "short",
            timeZone: zone,
          })
  const time = date.toLocaleTimeString("en-GB", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: zone,
  })
  return `${day}, ${time}`
}

const HOUR = 3_600_000

/**
 * A written reminder as the panel shows it. Its due time is in `zone`, the
 * reader's own, and absent while that is unknown (the server's render), so
 * the same time never shows first in UTC and then in local time. `soon` is
 * due within the hour, and waits for the zone the same way.
 */
export const noteOf = (
  note: Reminder,
  zone: string | null,
  now = new Date()
) => {
  const due = zone && note.due_at ? dueLine(note.due_at, zone, now) : null
  return {
    title: note.title,
    due,
    soon: due !== null && Date.parse(note.due_at ?? "") - now.getTime() <= HOUR,
    byAssistant: note.source === "assistant",
  }
}

/**
 * The written reminders still ahead: dated ones not yet due, then undated
 * ones, in the api's order, which is already soonest first.
 */
export const upcomingNotes = (notes: Reminder[], now = Date.now()) =>
  notes.filter((note) => note.due_at === null || Date.parse(note.due_at) > now)
