import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps, ReactNode } from "react"

/**
 * One position in the reporting line. The package stays presentational, so this
 * is the shape the tree draws and not the staff row it came from.
 */
type OrgTreeNode = {
  id: string
  /** The person or agent's name. */
  title: string
  /** Their position, or whatever second line the caller wants. */
  subtitle?: string | null
  /** A short code shown beside the name, e.g. `COS-001`. */
  code?: string | null
  badge?: ReactNode
  reports: OrgTreeNode[]
}

/**
 * The `manager_id` closure (§5.2) as nested lists.
 *
 * Nested `<ul>` rather than the ARIA tree pattern on purpose. This is a
 * hierarchy to read, not a widget to operate: there is nothing to expand,
 * select or activate, so `role="tree"` would promise arrow-key navigation and
 * a roving tabindex that do not exist and would be a worse experience than the
 * list semantics a screen reader already announces with depth and position.
 */
function OrgTree({
  nodes,
  className,
  ...props
}: Omit<ComponentProps<"ul">, "children"> & { nodes: OrgTreeNode[] }) {
  return (
    <ul className={cn("flex flex-col gap-2", className)} {...props}>
      {nodes.map((node) => (
        <OrgTreeItem key={node.id} node={node} />
      ))}
    </ul>
  )
}

function OrgTreeItem({ node }: { node: OrgTreeNode }) {
  return (
    <li className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-2xl bg-card px-3 py-2 text-sm shadow-sm ring-1 ring-foreground/5 dark:ring-foreground/10">
        <span className="font-medium">{node.title}</span>
        {node.subtitle ? (
          <span className="text-muted-foreground">{node.subtitle}</span>
        ) : null}
        {node.code ? (
          <span className="font-mono text-muted-foreground text-xs">
            {node.code}
          </span>
        ) : null}
        {node.badge ? <span className="ms-auto">{node.badge}</span> : null}
      </div>
      {node.reports.length > 0 ? (
        // The rule draws the reporting line. It is a border rather than an
        // icon, so it inherits the border token and needs no dark-mode variant.
        <ul className="mt-2 flex flex-col gap-2 border-border border-s ps-4 md:ps-6">
          {node.reports.map((report) => (
            <OrgTreeItem key={report.id} node={report} />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export type { OrgTreeNode }
export { OrgTree }
