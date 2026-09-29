import { CheckCircleIcon } from "@phosphor-icons/react"
import { createFileRoute, getRouteApi } from "@tanstack/react-router"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { Button } from "@workspace/ui/components/button"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { ListFilter } from "@workspace/ui/components/list-filter"
import { useState } from "react"
import { validateListSearch } from "@/lib/search"
import { useLiveWorkspace } from "@/lib/workspace"
import { Decidable } from "@/panel/workspace-panel"

export const Route = createFileRoute("/app/approvals")({
  validateSearch: validateListSearch,
  component: Approvals,
})

const frame = getRouteApi("/app")

/**
 * The approvals in the frame's live workspace, each decided exactly as the
 * panel decides it, so both surfaces read and write the same way.
 */
function Approvals() {
  const { q } = Route.useSearch()
  const navigate = Route.useNavigate()
  const { names } = frame.useLoaderData()
  const { workspace, refresh } = useLiveWorkspace()
  const [status, setStatus] = useState<string | null>(null)

  if (!workspace) {
    return (
      <EmptyState
        action={
          <Button onClick={() => void refresh()} variant="outline">
            Try again
          </Button>
        }
        description="Approvals could not be loaded. Nothing was changed."
        icon={<CheckCircleIcon />}
        role="alert"
        title="Something went wrong"
      />
    )
  }

  const approvals = workspace.attention.flatMap((item) =>
    item.kind === "approval" ? [item] : []
  )
  const needle = (q ?? "").toLowerCase()
  const matches = needle
    ? approvals.filter((item) =>
        [
          item.title,
          (item.raisedById && names[item.raisedById]) || item.raisedBy,
          item.request.action_kind,
        ].some((field) => field.toLowerCase().includes(needle))
      )
    : approvals

  return (
    <>
      <PageHeader
        description="Decisions Reme cannot take on its own. Each one shows what it changes and when it expires."
        title="Approvals"
      />

      <p className="mb-4 text-sm empty:hidden" role="status">
        {status}
      </p>

      {approvals.length === 0 ? (
        <EmptyState
          description="Approval requests appear here as Reme raises them."
          icon={<CheckCircleIcon />}
          title="Nothing waiting on you"
        />
      ) : (
        <section aria-labelledby="approvals-waiting">
          {/* The cards are h3, matching the panel where they sit under a
              section heading. This page has no visible h2 of its own, so name
              the region for a screen reader rather than let the outline skip a
              level between the page title and the first card. */}
          <h2 className="sr-only" id="approvals-waiting">
            Approvals waiting on you
          </h2>
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
          {matches.length === 0 ? (
            <EmptyState
              description="No approval matches that filter."
              icon={<CheckCircleIcon />}
              title="No matches"
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {matches.map((item) => (
                <li key={item.id}>
                  <Decidable
                    announce={setStatus}
                    item={item}
                    refresh={refresh}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  )
}
