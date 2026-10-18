import {
  ClipboardTextIcon,
  QuestionIcon,
  SealCheckIcon,
  WarningIcon,
} from "@phosphor-icons/react"

/**
 * The owner attention contract (§7.3): Question, ApprovalRequest, Report and
 * Alert, and nothing else. A fifth kind is a change to what the product
 * promises the owner, so it is an ADR rather than a new value here, and the
 * union below is what makes that a type error instead of a code review.
 */
type AttentionKind = "question" | "approval" | "report" | "alert"

const KIND: Record<
  AttentionKind,
  {
    label: string
    icon: typeof QuestionIcon
    variant: "secondary" | "destructive"
  }
> = {
  question: { label: "Question", icon: QuestionIcon, variant: "secondary" },
  approval: { label: "Approval", icon: SealCheckIcon, variant: "secondary" },
  report: { label: "Report", icon: ClipboardTextIcon, variant: "secondary" },
  alert: { label: "Alert", icon: WarningIcon, variant: "destructive" },
}

export type { AttentionKind }
export { KIND as attentionKind }
