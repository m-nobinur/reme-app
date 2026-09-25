import { CheckCircleIcon } from "@phosphor-icons/react"
import { createFileRoute, useRouter } from "@tanstack/react-router"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { ApprovalTargetSummary } from "@workspace/ui/components/approval-target"
import { AttentionCard } from "@workspace/ui/components/attention-card"
import { Button } from "@workspace/ui/components/button"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { ListFilter } from "@workspace/ui/components/list-filter"
import { useState } from "react"
import { decideApproval, getApprovals } from "@/lib/api/server"
import type { ApprovalItem } from "@/lib/api/types"
import { validateListSearch } from "@/lib/search"

export const Route = createFileRoute("/app/approvals")({
  validateSearch: validateListSearch,
  loader: async () => await getApprovals(),
  component: Approvals,
})

function Approvals() {
  const { q } = Route.useSearch()
  const navigate = Route.useNavigate()
  const router = useRouter()
  const { approvals } = Route.useLoaderData()
  const [pending, setPending] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  /**
   * Nothing changes on screen until the server has answered. An approval is
   * the one place an optimistic update is wrong: showing it as approved before
   * the decision is recorded tells the owner something happened that may not
   * have. The decision names the version on the card, so it cannot land on a
   * newer one the owner has not seen.
   */
  const decide = (item: ApprovalItem, decision: "approved" | "rejected") => {
    const { target, approval_id: approvalId } = item.request
    if (target.kind !== "revision") {
      return
    }
    setPending(approvalId)
    setFailed(null)
    void (async () => {
      try {
        await decideApproval({
          data: { approvalId, revisionId: target.revision_id, decision },
        })
        await router.invalidate()
      } catch {
        setFailed(approvalId)
      } finally {
        setPending(null)
      }
    })()
  }

  const needle = (q ?? "").toLowerCase()
  const matches = needle
    ? approvals.filter((item) =>
        [item.title, item.requestedBy, item.request.action_kind].some((field) =>
          field.toLowerCase().includes(needle)
        )
      )
    : approvals

  return (
    <>
      <PageHeader
        description="Decisions Reme cannot take on its own. Each one shows what it changes and when it expires."
        title="Approvals"
      />

      {approvals.length === 0 ? (
        <EmptyState
          description="Approval requests appear here as Reme raises them."
          icon={<CheckCircleIcon />}
          title="Nothing waiting on you"
        />
      ) : (
        <section aria-labelledby="approvals-waiting">
          {/* The cards are h3, matching the dashboard where they sit under a
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
                <li key={item.request.approval_id}>
                  <AttentionCard
                    // One tap each, both in reach, neither behind a menu or a
                    // disclosure, and the target they act on is on the card
                    // above them rather than a screen away.
                    actions={
                      <>
                        <Button
                          disabled={pending !== null}
                          onClick={() => decide(item, "approved")}
                        >
                          Approve and publish v{item.version}
                        </Button>
                        <Button
                          disabled={pending !== null}
                          onClick={() => decide(item, "rejected")}
                          variant="outline"
                        >
                          Decline
                        </Button>
                        {failed === item.request.approval_id ? (
                          <p
                            className="basis-full text-destructive text-sm"
                            role="alert"
                          >
                            That did not go through. Try again.
                          </p>
                        ) : null}
                      </>
                    }
                    detail={item.request.rationale}
                    expiresAt={item.request.expires_at}
                    kind="approval"
                    onExpiry={item.onExpiry}
                    raisedAt={item.request.requested_at}
                    raisedBy={item.requestedBy}
                    target={
                      <ApprovalTargetSummary target={item.request.target} />
                    }
                    title={item.title}
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
