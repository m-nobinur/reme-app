import { PulseIcon } from "@phosphor-icons/react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { ApprovalTargetSummary } from "@workspace/ui/components/approval-target"
import { AttentionCard } from "@workspace/ui/components/attention-card"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { StatTile } from "@workspace/ui/components/stat-tile"
import { formatDate } from "@workspace/ui/lib/format"
import { getDashboard } from "@/lib/api/server"

export const Route = createFileRoute("/app/")({
  loader: async () => await getDashboard(),
  component: Dashboard,
})

function Dashboard() {
  const { org, attention, activity, counts } = Route.useLoaderData()

  return (
    <>
      <PageHeader
        description="What Reme did, what it is waiting on you for, and what it wants to do next."
        title="Dashboard"
      />

      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        <StatTile hint="active" label="Staff" value={counts.staff} />
        <StatTile hint="items" label="Waiting on you" value={counts.waiting} />
        <StatTile
          hint="need an action"
          label="Pipeline"
          value={counts.pipeline}
        />
      </div>

      <section aria-labelledby="attention" className="mb-8">
        <h2 className="mb-3 font-medium text-lg" id="attention">
          Waiting on you
        </h2>
        {attention.length === 0 ? (
          <EmptyState
            description={
              org
                ? "Reme raises a question, an approval, a report or an alert here. Nothing so far."
                : "Activity appears here once an organisation is connected."
            }
            icon={<PulseIcon />}
            title="Nothing waiting on you"
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {attention.map((item) => (
              <li key={item.id}>
                <AttentionCard
                  actions={
                    item.kind === "approval" ? (
                      <Link
                        className="text-primary text-sm underline underline-offset-4"
                        to="/app/approvals"
                      >
                        Review in approvals
                      </Link>
                    ) : null
                  }
                  detail={item.detail}
                  expiresAt={item.expiresAt}
                  kind={item.kind}
                  onExpiry={item.onExpiry}
                  raisedAt={item.raisedAt}
                  raisedBy={item.raisedBy}
                  target={
                    item.kind === "approval" ? (
                      <ApprovalTargetSummary target={item.request.target} />
                    ) : null
                  }
                  title={item.title}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="activity">
        <h2 className="mb-3 font-medium text-lg" id="activity">
          Recent activity
        </h2>
        {activity.length === 0 ? (
          <EmptyState
            description="Every hire, change and delivery lands here as it happens."
            icon={<PulseIcon />}
            title="No activity yet"
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {activity.map((item) => (
              <li
                className="flex flex-wrap items-baseline justify-between gap-2 border-border border-b py-2 text-sm last:border-b-0"
                key={item.id}
              >
                <span>{item.summary}</span>
                <span className="text-muted-foreground text-xs">
                  {formatDate(item.occurredAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}
