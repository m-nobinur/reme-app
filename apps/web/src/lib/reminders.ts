import type { DerivedReminder, FactValueKey } from "@workspace/contracts"
import type { ReminderRow } from "@workspace/ui/components/live-panel"
import { factLabel } from "@workspace/ui/lib/facts"
import { formatDateTime } from "@workspace/ui/lib/format"
import type { AttentionItem, Workspace } from "./api/types"

/**
 * Derived reminders in the owner's words, for the panel and the briefing.
 * The api sends facts about rows that wait on the owner; the words are
 * written here, from those facts and the rows the workspace already holds.
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

/**
 * The panel's rows. A row links to its item only when the panel shows that
 * item: the approval or question in "Waiting on you", or the build in
 * "Working on" (`shownBuild`).
 */
export function reminderRows(
  workspace: Workspace,
  shownBuild: string | null
): ReminderRow[] {
  const { attention, derivedReminders } = workspace
  const shown = (id: string) => attention.some((item) => item.id === id)
  return derivedReminders.map((reminder): ReminderRow => {
    switch (reminder.rule) {
      case "approval_expiring":
        return {
          id: `review-${reminder.approval_id}`,
          text: `Review version ${reminder.version} before it closes`,
          href: shown(reminder.approval_id)
            ? `#${anchorOf.approval(reminder.approval_id)}`
            : null,
        }
      case "question_waiting": {
        const question = questionOf(attention, reminder)
        return question
          ? {
              id: `question-${reminder.request_id}`,
              text: `Answer the question about ${question.title.toLowerCase()}`,
              detail: `Waiting on you since ${formatDateTime(question.raisedAt)}`,
              href: `#${anchorOf.question(question.id)}`,
            }
          : {
              id: `question-${reminder.request_id}`,
              text: "A question is still waiting on you",
            }
      }
      case "preview_unpublished": {
        const approval = attention.find(
          (item) =>
            item.kind === "approval" &&
            item.request.assignment_id === reminder.assignment_id
        )
        return {
          id: `preview-${reminder.assignment_id}-${reminder.version}`,
          text: `Version ${reminder.version} is ready but not published`,
          href: approval
            ? `#${anchorOf.approval(approval.id)}`
            : shownBuild === reminder.assignment_id
              ? `#${anchorOf.build(reminder.assignment_id)}`
              : null,
        }
      }
      default:
        return {
          id: "facts",
          text: `Tell Reme ${factsNeeded(reminder.keys)}`,
        }
    }
  })
}
