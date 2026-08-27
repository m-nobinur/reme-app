import { createFileRoute, Link, redirect } from "@tanstack/react-router"
import { Alert } from "@workspace/ui/components/alert"
import { AuthCard } from "@workspace/ui/components/auth-card"
import { Button } from "@workspace/ui/components/button"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { chooseOrganization, getPendingAuth } from "@/lib/auth/actions"
import { useSubmit } from "@/lib/auth/use-submit"

export const Route = createFileRoute("/choose-organisation")({
  loader: async () => {
    const pending = await getPendingAuth()
    if (!pending) {
      throw redirect({ to: "/sign-in" })
    }
    return pending
  },
  component: ChooseOrganisation,
})

function ChooseOrganisation() {
  const pending = Route.useLoaderData()
  const { run, pending: busy, result } = useSubmit(chooseOrganization)

  const failure = result?.status === "failed" ? result.failure : undefined

  return (
    <AuthCard
      brand={<Link to="/">Reme</Link>}
      description={`${pending.email} belongs to more than one. Pick the one to work in.`}
      footer={
        <Link
          className="text-foreground underline underline-offset-4"
          to="/sign-in"
        >
          Use a different account
        </Link>
      }
      title="Choose an organisation"
    >
      {failure ? <Alert variant="error">{failure.message}</Alert> : null}

      {pending.organizations.length === 0 ? (
        // Reachable if the flow cookie survived but the offer did not. Nothing
        // is invented to fill the list.
        <EmptyState
          className="mt-4"
          description="We could not read the organisations on this account. Signing in again will ask WorkOS for them afresh."
          role="alert"
          title="No organisations to show"
        />
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {pending.organizations.map((org) => (
            <li key={org.id}>
              <Button
                className="w-full justify-start"
                disabled={busy}
                onClick={async () => {
                  const outcome = await run({
                    data: { organizationId: org.id },
                  })
                  if (outcome.status !== "failed") {
                    window.location.assign(outcome.redirectTo)
                  }
                }}
                type="button"
                variant="outline"
              >
                {org.name}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </AuthCard>
  )
}
