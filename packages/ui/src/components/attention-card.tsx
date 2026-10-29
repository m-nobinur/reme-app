import { QuestionIcon, RocketLaunchIcon } from "@phosphor-icons/react"
import { STATE_MARKS } from "@workspace/ui/lib/status-icons"

/**
 * The owner attention contract (§7.3): Question, ApprovalRequest, Report,
 * Alert and Reminder, and nothing else. A sixth kind is a change to what the
 * product promises the owner, so it is an ADR rather than a new value here,
 * and the union below is what makes that a type error instead of a code
 * review.
 */
type AttentionKind = "question" | "approval" | "report" | "alert" | "reminder"

const KIND: Record<
  AttentionKind,
  {
    label: string
    icon: typeof QuestionIcon
    variant: "secondary" | "destructive"
  }
> = {
  question: { label: "Question", icon: QuestionIcon, variant: "secondary" },
  approval: {
    label: "Approval",
    icon: STATE_MARKS.waiting.Icon,
    variant: "secondary",
  },
  // Every report is a publish.
  report: { label: "Report", icon: RocketLaunchIcon, variant: "secondary" },
  alert: {
    label: "Alert",
    icon: STATE_MARKS.failed.Icon,
    variant: "destructive",
  },
  reminder: {
    label: "Reminder",
    icon: STATE_MARKS.reminder.Icon,
    variant: "secondary",
  },
}

export type { AttentionKind }
export { KIND as attentionKind }
