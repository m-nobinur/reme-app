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
  version,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  target: ApprovalTarget
  /** The revision's version number, which is what an owner calls it. */
  version?: number
}) {
  const { label, value, id } = describe(target, version)
  return (
    <div
      className={cn(
        "rounded-2xl bg-muted px-3 py-2 text-muted-foreground text-xs",
        className
      )}
      {...props}
    >
      <span>{label}</span>
      <p
        className={cn(
          "mt-0.5 break-words text-foreground text-sm",
          id ? null : "font-mono"
        )}
      >
        {value}
      </p>
      {id ? <p className="mt-0.5">ID {id}</p> : null}
    </div>
  )
}

function describe(
  target: ApprovalTarget,
  version?: number
): { label: string; value: string; id?: string } {
  switch (target.kind) {
    case "revision":
      // The version is what the owner reads; the short id is what support
      // and the preview link match it against. The full id is never shown
      // as though it were a version.
      return {
        label: "Site",
        value: version === undefined ? "A new version" : `Version ${version}`,
        id: target.revision_id.slice(0, 8),
      }
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
