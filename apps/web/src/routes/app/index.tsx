import { PulseIcon } from "@phosphor-icons/react"
import { createFileRoute } from "@tanstack/react-router"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { EmptyState } from "@workspace/ui/components/empty-state"

export const Route = createFileRoute("/app/")({ component: Dashboard })

function Dashboard() {
  return (
    <>
      <PageHeader
        description="What Reme did, what it is waiting on you for, and what it wants to do next."
        title="Dashboard"
      />
      <EmptyState
        description="Nothing has run yet. Activity appears here once an organisation is connected."
        icon={<PulseIcon />}
        title="No activity yet"
      />
    </>
  )
}
