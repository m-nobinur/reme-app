import { CaretRightIcon, SpinnerGapIcon } from "@phosphor-icons/react"
import { createFileRoute, Link, redirect } from "@tanstack/react-router"
import { Alert } from "@workspace/ui/components/alert"
import { AuthCard } from "@workspace/ui/components/auth-card"
import { Button } from "@workspace/ui/components/button"
import { EmptyState } from "@workspace/ui/components/empty-state"
import { Logo } from "@workspace/ui/components/logo"
import { useState } from "react"
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
  head: () => ({ meta: [{ title: "Choose an organisation · Reme" }] }),
  component: ChooseOrganisation,
})

function ChooseOrganisation() {
  const pending = Route.useLoaderData()
  // Which row was clicked, so the spinner lands on the one being opened rather
  // than on all of them at once.
  const [opening, setOpening] = useState<string | null>(null)
  const { run, pending: busy, result } = useSubmit(chooseOrganization)

  const failure = result?.status === "failed" ? result.failure : undefined

  return (
    <AuthCard
      brand={
        <Link to="/">
          <Logo />
        </Link>
      }
      description={
        <>
          <span className="text-foreground">{pending.email}</span> belongs to
          more than one. Pick the one to work in. You can switch later without
          signing in again.
        </>
      }
      footer={
        <Link
          className="font-medium text-foreground underline underline-offset-4"
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
        <ul className="flex flex-col gap-2">
          {pending.organizations.map((org) => (
            <li key={org.id}>
              <Button
                aria-busy={opening === org.id || undefined}
                aria-disabled={busy || undefined}
                className="h-11 w-full justify-between aria-disabled:opacity-60"
                onClick={async () => {
                  if (busy) {
                    return
                  }
                  setOpening(org.id)
                  const outcome = await run({
                    data: { organizationId: org.id },
                  })
                  if (outcome.status !== "failed") {
                    window.location.assign(outcome.redirectTo)
                    return
                  }
                  setOpening(null)
                }}
                type="button"
                variant="outline"
              >
                {org.name}
                {opening === org.id ? (
                  <SpinnerGapIcon aria-hidden className="animate-spin" />
                ) : (
                  <CaretRightIcon aria-hidden />
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </AuthCard>
  )
}
