import type {
  DerivedReminder,
  FactValueKey,
  Reminder,
} from "@workspace/contracts"
import { reminderTitle } from "@workspace/ui/lib/activity-copy"
import { factLabel } from "@workspace/ui/lib/facts"
import { dayLabel, dayOf, formatTime } from "@workspace/ui/lib/format"
import type { AttentionItem } from "./api/types"
import { leading } from "./briefing"

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

/** `Today, 4:30 PM`, `Tomorrow, 9:00 AM`, else `Fri 3 Oct, 9:00 AM`, in `zone`. */
export function dueLine(at: string, zone: string, now = new Date()): string {
  const date = new Date(at)
  return `${dayLabel(date, zone, now)}, ${formatTime(date, zone)}`
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
  const left = Date.parse(note.due_at ?? "") - now.getTime()
  return {
    title: reminderTitle(note.title),
    due,
    soon: due !== null && left > 0 && left <= HOUR,
    overdue: due !== null && left <= 0,
  }
}

/**
 * The written reminders still ahead: dated ones not yet due, then undated
 * ones, in the api's order, which is already soonest first.
 */
export const upcomingNotes = (notes: Reminder[], now = Date.now()) =>
  notes.filter((note) => note.due_at === null || Date.parse(note.due_at) > now)

/**
 * A derived reminder as the reminders page words it. `focus` opens the panel
 * on the item; `chat` starts a new chat, since facts are told to the assistant there.
 */
export type Needed = {
  key: string
  title: string
  detail: string
  action: { label: string } & ({ focus: string } | { chat: true })
}

type ReminderGroup = {
  id: "overdue" | "today" | "upcoming" | "dated" | "undated"
  title: string
  notes: Reminder[]
}

const neededOf = (
  reminder: DerivedReminder,
  attention: AttentionItem[],
  zone: string | null,
  now: Date,
  assistant: string
): Needed => {
  switch (reminder.rule) {
    case "approval_expiring": {
      // Within a day of expiry, so the line always starts Today or Tomorrow.
      const closes = zone
        ? `Due ${dueLine(reminder.expires_at, zone, now).replace(/^T/, "t")}.`
        : "Due within a day."
      return {
        key: `approval-${reminder.approval_id}`,
        title: "Your website is ready to publish",
        detail: closes,
        action: {
          label: "Review",
          focus: anchorOf.approval(reminder.approval_id),
        },
      }
    }
    case "question_waiting": {
      const question = questionOf(attention, reminder)
      return {
        key: `question-${reminder.request_id}`,
        title: question
          ? `${leading(assistant)} asked about ${question.title.toLowerCase()}`
          : "A question is waiting for your answer",
        detail: "Waiting for over 12 hours.",
        action: {
          label: "Show the question",
          focus: anchorOf.question(reminder.request_id),
        },
      }
    }
    case "preview_unpublished":
      return {
        key: `build-${reminder.assignment_id}`,
        title: "Your changes aren't published yet",
        detail: "Ready for over 12 hours.",
        action: {
          label: "Open in the panel",
          focus: anchorOf.build(reminder.assignment_id),
        },
      }
    case "facts_missing":
      return {
        key: "facts",
        title: `${leading(assistant)} still needs ${factsNeeded(reminder.keys)}`,
        detail: "Your website shows these.",
        action: { label: `Tell ${assistant}`, chat: true },
      }
  }
}

/**
 * The reminders page, in order: what needs the owner now, then written
 * reminders overdue, due today, due later and undated, each list in the
 * api's order. Days are the reader's, in `zone`; `assistant` is what the owner
 * calls theirs (`assistantOf`). While the zone is unknown
 * (the server's render) dated reminders share one group, so the server and
 * the first browser render agree. Empty groups are left out.
 */
export function groupReminders(
  notes: Reminder[],
  derived: DerivedReminder[],
  attention: AttentionItem[],
  zone: string | null,
  assistant: string,
  now = new Date()
): { needed: Needed[]; groups: ReminderGroup[] } {
  const dated = notes.filter((note) => note.due_at !== null)
  const undated = notes.filter((note) => note.due_at === null)
  const due = (note: Reminder) => Date.parse(note.due_at ?? "")
  const today = zone ? dayOf(now, zone) : 0
  const groups: ReminderGroup[] = zone
    ? [
        {
          id: "overdue",
          title: "Overdue",
          notes: dated.filter((note) => due(note) <= now.getTime()),
        },
        {
          id: "today",
          title: "Today",
          notes: dated.filter(
            (note) =>
              due(note) > now.getTime() &&
              dayOf(new Date(due(note)), zone) === today
          ),
        },
        {
          id: "upcoming",
          title: "Upcoming",
          notes: dated.filter(
            (note) => dayOf(new Date(due(note)), zone) > today
          ),
        },
      ]
    : [{ id: "dated", title: "Scheduled", notes: dated }]
  groups.push({ id: "undated", title: "No date", notes: undated })
  return {
    needed: derived.map((each) =>
      neededOf(each, attention, zone, now, assistant)
    ),
    groups: groups.filter((group) => group.notes.length > 0),
  }
}
