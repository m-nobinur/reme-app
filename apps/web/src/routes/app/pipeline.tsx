import { createFileRoute } from "@tanstack/react-router"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { Badge } from "@workspace/ui/components/badge"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { ListFilter } from "@workspace/ui/components/list-filter"
import { PipelineIcon } from "@workspace/ui/components/pipeline-icon"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { formatDate } from "@workspace/ui/lib/format"
import { getPipeline } from "@/lib/api/server"
import type { PipelineStage } from "@/lib/api/types"
import { validateListSearch } from "@/lib/search"

export const Route = createFileRoute("/app/pipeline")({
  validateSearch: validateListSearch,
  loader: async () => await getPipeline(),
  component: Pipeline,
})

/** The §4 lead lifecycle, in the order it runs. */
const STAGE: Record<PipelineStage, string> = {
  new: "New",
  qualifying: "Qualifying",
  quoted: "Quoted",
  booked: "Booked",
  completed: "Completed",
}

function Pipeline() {
  const { q } = Route.useSearch()
  const navigate = Route.useNavigate()
  const { items } = Route.useLoaderData()

  const needle = (q ?? "").toLowerCase()
  const matches = needle
    ? items.filter((item) =>
        [item.customer, item.summary, item.channel, STAGE[item.stage]].some(
          (field) => field.toLowerCase().includes(needle)
        )
      )
    : items

  return (
    <>
      <PageHeader
        description="Enquiries, quotes and bookings, in the order they need attention."
        title="Pipeline"
      />

      {items.length === 0 ? (
        <EmptyState
          description="Enquiries appear here once your intake channels are connected."
          icon={<PipelineIcon />}
          title="No enquiries yet"
        />
      ) : (
        <>
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
          {matches.length === 0 ? (
            <EmptyState
              description="No enquiry matches that filter."
              icon={<PipelineIcon />}
              title="No matches"
            />
          ) : (
            <Table>
              <TableCaption>
                {matches.length} of {items.length} enquiries. Every stage has a
                next action and someone it belongs to.
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Customer</TableHead>
                  <TableHead scope="col">Stage</TableHead>
                  <TableHead scope="col">Next action</TableHead>
                  <TableHead scope="col">With</TableHead>
                  <TableHead scope="col">Follow up</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {matches.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="max-w-xs whitespace-normal align-top">
                      <span className="font-medium">{item.customer}</span>
                      <span className="block text-muted-foreground text-xs">
                        {item.channel} · {formatDate(item.receivedAt)}
                      </span>
                      <span className="block max-w-prose text-muted-foreground text-xs">
                        {item.summary}
                      </span>
                    </TableCell>
                    <TableCell className="align-top">
                      <Badge variant="secondary">{STAGE[item.stage]}</Badge>
                    </TableCell>
                    <TableCell className="max-w-xs whitespace-normal align-top">
                      {item.nextAction}
                    </TableCell>
                    <TableCell className="align-top">
                      {item.ownerStaffName}
                    </TableCell>
                    <TableCell className="align-top text-muted-foreground">
                      {formatDate(item.followUpAt) ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </>
  )
}
