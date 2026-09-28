import {
  ClipboardTextIcon,
  QuestionIcon,
  SealCheckIcon,
  WarningIcon,
} from "@phosphor-icons/react"
import { Badge } from "@workspace/ui/components/badge"
import { formatDateTime } from "@workspace/ui/lib/format"
import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps, ReactNode } from "react"

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

/**
 * One item in the owner's inbox.
 *
 * Everything an owner needs to answer is on the card: what is being asked, who
 * asked, what it is bound to, when it expires and what happens if it does. The
 * expiry line is not decoration — §13 says nothing goes ahead on its own, so
 * the card always says what the silence means.
 *
 * `target` is a slot rather than a shape this package knows, because the
 * immutable target of an approval is a contract type and rendering it is the
 * app's job; what this component guarantees is that it is displayed next to
 * the buttons that act on it, and never behind a disclosure.
 */
function AttentionCard({
  kind,
  title,
  detail,
  raisedBy,
  raisedAt,
  expiresAt,
  onExpiry,
  target,
  actions,
  className,
  ...props
}: Omit<ComponentProps<"article">, "title"> & {
  kind: AttentionKind
  title: string
  detail: string
  raisedBy: string
  raisedAt: string
  expiresAt?: string | null
  onExpiry: string
  target?: ReactNode
  actions?: ReactNode
}) {
  const meta = KIND[kind]
  const Icon = meta.icon
  const raised = formatDateTime(raisedAt)
  const expires = formatDateTime(expiresAt)

  return (
    <article
      className={cn(
        "flex flex-col gap-3 rounded-4xl bg-card p-5 text-card-foreground shadow-sm ring-1 ring-foreground/5 dark:ring-foreground/10",
        className
      )}
      data-kind={kind}
      {...props}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={meta.variant}>
          <Icon aria-hidden />
          {meta.label}
        </Badge>
        <span className="text-muted-foreground text-xs">
          {raisedBy}
          {raised ? ` · ${raised}` : null}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <h3 className="font-medium text-base">{title}</h3>
        {/* Model output is bounded here rather than trusted to be short. */}
        <p className="line-clamp-4 max-w-prose text-muted-foreground text-sm">
          {detail}
        </p>
      </div>

      {target}

      <p className="text-muted-foreground text-xs">
        {expires ? (
          <>
            <span className="font-medium text-foreground">
              Expires {expires}.
            </span>{" "}
          </>
        ) : null}
        {onExpiry}
      </p>

      {actions ? (
        <div className="flex flex-wrap gap-2 pt-1">{actions}</div>
      ) : null}
    </article>
  )
}

export type { AttentionKind }
export { AttentionCard, KIND as attentionKind }
