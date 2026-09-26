import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps } from "react"

type OrgOption = { id: string; name: string }

/**
 * Picks the organisation the dashboard is scoped to. A native select because
 * it is keyboard- and screen-reader-correct for free at this size.
 *
 * Presentational: the caller owns the value and the change handler, and the
 * option ids are whatever the caller's server accepts. An owner with one
 * organisation gets a disabled control showing its name, and an owner with
 * none gets "No organisation" rather than an invented one.
 */
function OrgSwitcher({
  orgs,
  className,
  ...props
}: Omit<ComponentProps<"select">, "children"> & { orgs: OrgOption[] }) {
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <label
        className="px-1 text-[0.8125rem] text-muted-foreground"
        htmlFor="org-switcher"
      >
        Organisation
      </label>
      <select
        // Ellipsis rather than a name cut mid-letter under the arrow: a long
        // business name is common, and the rail is 15rem.
        className="h-9 w-full truncate rounded-2xl border border-border bg-background ps-2 pe-8 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring disabled:opacity-60"
        disabled={orgs.length < 2}
        id="org-switcher"
        name="org"
        // The whole name, where the ellipsis cut it.
        title={orgs.find((org) => org.id === props.value)?.name}
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
