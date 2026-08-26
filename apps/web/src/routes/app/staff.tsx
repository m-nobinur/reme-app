import { UsersThreeIcon } from "@phosphor-icons/react"
import { createFileRoute } from "@tanstack/react-router"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { ListFilter } from "@workspace/ui/components/list-filter"
import { validateListSearch } from "@/lib/search"

export const Route = createFileRoute("/app/staff")({
  validateSearch: validateListSearch,
  component: Staff,
})

function Staff() {
  const { q } = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <>
      <PageHeader
        description="The people and the AI roles that make up your organisation."
        title="Staff"
      />
      <ListFilter
        label="Filter staff"
        onValueChange={(value) => {
          // The filter lives in the URL, so a filtered view is shareable and
          // survives a reload. Changing it resets to the first page.
          navigate({
            replace: true,
            search: { page: 1, q: value || undefined },
          })
        }}
        value={q ?? ""}
      />
      <EmptyState
        description="People and roles appear here once your organisation is set up."
        icon={<UsersThreeIcon />}
        title="No staff yet"
      />
    </>
  )
}
