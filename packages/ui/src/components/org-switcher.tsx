import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps } from "react"

type OrgOption = { id: string; name: string }

/**
 * Picks the organisation the dashboard is scoped to. A native select because
 * it is keyboard- and screen-reader-correct for free at this size.
 *
 * There is no organisation data source yet, so the list arrives empty and the
 * control is inert. Selecting an organisation changes nothing until the org
 * read lands; the handler goes on this element when it does.
 */
function OrgSwitcher({
  orgs,
  className,
  ...props
}: Omit<ComponentProps<"select">, "children"> & { orgs: OrgOption[] }) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label
        className="px-1 font-medium text-sidebar-foreground/60 text-xs uppercase tracking-wide"
        htmlFor="org-switcher"
      >
        Organisation
      </label>
      <select
        className="h-9 w-full rounded-2xl border border-sidebar-border bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-60"
        disabled={orgs.length < 2}
        id="org-switcher"
        name="org"
        {...props}
      >
        {orgs.length === 0 ? (
          <option>No organisation</option>
        ) : (
          orgs.map((org) => (
            <option key={org.id} value={org.id}>
              {org.name}
            </option>
          ))
        )}
      </select>
    </div>
  )
}

export type { OrgOption }
export { OrgSwitcher }
