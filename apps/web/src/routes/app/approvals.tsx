import { CheckCircleIcon } from "@phosphor-icons/react"
import { createFileRoute } from "@tanstack/react-router"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { ListFilter } from "@workspace/ui/components/list-filter"
import { validateListSearch } from "@/lib/search"

export const Route = createFileRoute("/app/approvals")({
  validateSearch: validateListSearch,
  component: Approvals,
})

function Approvals() {
  const { q } = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <>
      <PageHeader
        description="Decisions Reme cannot take on its own. Each one shows what it changes and when it expires."
        title="Approvals"
      />
      <ListFilter
        label="Filter approvals"
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
        description="Approval requests appear here as Reme raises them."
        icon={<CheckCircleIcon />}
        title="Nothing waiting on you"
      />
    </>
  )
}
