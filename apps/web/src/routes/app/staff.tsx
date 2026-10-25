import { UsersThreeIcon } from "@phosphor-icons/react"
import { createFileRoute } from "@tanstack/react-router"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { Badge } from "@workspace/ui/components/badge"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { ListFilter } from "@workspace/ui/components/list-filter"
import { OrgTree, type OrgTreeNode } from "@workspace/ui/components/org-tree"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { getStaffDirectory } from "@/lib/api/server"
import type { OrgNode } from "@/lib/api/types"
import { validateListSearch } from "@/lib/search"

export const Route = createFileRoute("/app/staff")({
  validateSearch: validateListSearch,
  loader: async () => await getStaffDirectory(),
  component: Staff,
})

function Staff() {
  const { q } = Route.useSearch()
  const navigate = Route.useNavigate()
  const { staff, tree } = Route.useLoaderData()

  const needle = (q ?? "").toLowerCase()
  const matches = needle
    ? staff.filter((member) =>
        [
          member.displayName,
          member.staffCode,
          member.roleTitle,
          member.departmentName,
          member.positionTitle,
        ]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(needle))
      )
    : staff

  return (
    <>
      <PageHeader
        description="The people and the AI roles that make up your organisation."
        title="Staff"
      />

      {staff.length === 0 ? (
        <EmptyState
          description="People and roles appear here once your organisation is set up."
          icon={<UsersThreeIcon />}
          title="No staff yet"
        />
      ) : (
        <>
          <section aria-labelledby="directory" className="mb-10">
            <h2 className="mb-3 font-medium text-lg" id="directory">
              Directory
            </h2>
            <ListFilter
              label="Filter staff"
              onValueChange={(value) => {
                // The filter lives in the URL, so a filtered view is shareable
                // and survives a reload. Changing it resets to the first page.
                navigate({
                  replace: true,
                  search: { page: 1, q: value || undefined },
                })
              }}
              value={q ?? ""}
            />
            {matches.length === 0 ? (
              <EmptyState
                description="No one in this organisation matches that filter."
                icon={<UsersThreeIcon />}
                title="No matches"
              />
            ) : (
              <Table>
                <TableCaption>
                  {matches.length} of {staff.length} staff.
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Name</TableHead>
                    <TableHead scope="col">Code</TableHead>
                    <TableHead scope="col">Role</TableHead>
                    <TableHead scope="col">Department</TableHead>
                    <TableHead scope="col">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {matches.map((member) => (
                    <TableRow key={member.id}>
                      <TableCell className="font-medium">
                        {member.displayName}
                        <span className="ms-2 text-muted-foreground text-xs">
                          {member.kind === "human" ? "Person" : "AI"}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-muted-foreground text-xs">
                        {member.staffCode}
                      </TableCell>
                      <TableCell>
                        {member.roleTitle ?? member.positionTitle ?? "—"}
                      </TableCell>
                      <TableCell>{member.departmentName ?? "—"}</TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(member.status)}>
                          {statusLabel(member.status)}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>

          <section aria-labelledby="org-tree">
            <h2 className="mb-1 font-medium text-lg" id="org-tree">
              Reporting lines
            </h2>
            <p className="mb-3 max-w-prose text-muted-foreground text-sm">
              Who reports to whom, across the whole organisation. The filter
              above does not apply here.
            </p>
            <OrgTree
              aria-label="Reporting lines"
              nodes={tree.map(toTreeNode)}
            />
          </section>
        </>
      )}
    </>
  )
}

/**
 * Staff lifecycle status (§5.4). Anything that is not `active` takes the
 * quieter variant, so a state this screen has not met yet still renders
 * honestly rather than being mislabelled as active.
 */
const statusVariant = (status: string) =>
  status === "active" ? ("secondary" as const) : ("outline" as const)

const statusLabel = (status: string) =>
  status.charAt(0).toUpperCase() + status.slice(1)

function toTreeNode(node: OrgNode): OrgTreeNode {
  return {
    id: node.staff.id,
    title: node.staff.displayName,
    subtitle: node.staff.positionTitle ?? node.staff.roleTitle,
    code: node.staff.staffCode,
    badge: (
      <Badge variant={statusVariant(node.staff.status)}>
        {statusLabel(node.staff.status)}
      </Badge>
    ),
    reports: node.reports.map(toTreeNode),
  }
}
