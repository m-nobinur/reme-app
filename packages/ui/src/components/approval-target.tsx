import type { ApprovalTarget } from "@workspace/contracts"
import { formatMoney } from "@workspace/ui/lib/format"
import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps } from "react"

/**
 * What an approval is bound to (§7.3), rendered from the contract's own
 * discriminated union.
 *
 * The union is the point. An approval names one immutable target, and the
 * owner has to be able to see which: a stale approval must not be able to read
 * as though it were granted for something else. So this takes `ApprovalTarget`
 * from `@workspace/contracts` rather than a loosened local shape, every branch
 * is rendered, and there is no fallback that would let an unknown target
 * display as blank.
 *
 * It is never collapsed behind a disclosure. An approval is one tap, and a
 * target the owner has to open something to read is not.
 */
function ApprovalTargetSummary({
  target,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & { target: ApprovalTarget }) {
  const { label, value } = describe(target)
  return (
    <div
      className={cn(
        "rounded-2xl bg-muted px-3 py-2 text-muted-foreground text-xs",
        className
      )}
      {...props}
    >
      <span className="uppercase tracking-wide">{label}</span>
      <p className="mt-0.5 break-words font-mono text-foreground text-sm">
        {value}
      </p>
    </div>
  )
}

function describe(target: ApprovalTarget): { label: string; value: string } {
  switch (target.kind) {
    case "revision":
      return { label: "Version", value: target.revision_id }
    case "domain":
      return { label: "Domain", value: target.hostname }
    case "spend":
      return {
        label: "Amount",
        value: formatMoney(
          Math.round(target.amount_usd * 100),
          target.currency
        ),
      }
    case "sensitive_claim":
      return { label: "Claim", value: target.claim }
  }
}

export { ApprovalTargetSummary }
