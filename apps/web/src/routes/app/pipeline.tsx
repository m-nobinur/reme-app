import { FlowArrowIcon } from "@phosphor-icons/react"
import { createFileRoute } from "@tanstack/react-router"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { ListFilter } from "@workspace/ui/components/list-filter"
import { validateListSearch } from "@/lib/search"

export const Route = createFileRoute("/app/pipeline")({
  validateSearch: validateListSearch,
  component: Pipeline,
})

function Pipeline() {
  const { q } = Route.useSearch()
  const navigate = Route.useNavigate()

  return (
    <>
      <PageHeader
        description="Enquiries, quotes and bookings, in the order they need attention."
        title="Pipeline"
      />
      <ListFilter
        label="Filter the pipeline"
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
        description="Enquiries appear here once your intake channels are connected."
        icon={<FlowArrowIcon />}
        title="No enquiries yet"
      />
    </>
  )
}
