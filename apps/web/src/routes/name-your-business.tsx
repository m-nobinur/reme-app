import { StorefrontIcon } from "@phosphor-icons/react"
import { createFileRoute, Link, redirect } from "@tanstack/react-router"
import { Alert } from "@workspace/ui/components/alert"
import { AuthCard, AuthForm } from "@workspace/ui/components/auth-card"
import { Field } from "@workspace/ui/components/field"
import { Logo } from "@workspace/ui/components/logo"
import { SubmitButton } from "@workspace/ui/components/submit-button"
import { nameBusiness } from "@/lib/auth/actions"
import { safeReturnTo } from "@/lib/auth/redirect-target"
import { useSubmit } from "@/lib/auth/use-submit"
import { requireOwner } from "@/lib/tenant"

/**
 * The business an account without one names before anything else. A first
 * Google sign-in lands here, since WorkOS makes the account and nothing on
 * the way asked for the business; email signup asks on its own form.
 */
export const Route = createFileRoute("/name-your-business")({
  // Optional, so a link here needs no search of its own; checked on use.
  validateSearch: (search: Record<string, unknown>): { returnTo?: string } =>
    typeof search.returnTo === "string" ? { returnTo: search.returnTo } : {},
  loaderDeps: ({ search }) => ({ returnTo: safeReturnTo(search.returnTo) }),
  loader: async ({ location, deps }) => {
    const owner = await requireOwner(location.href)
    // One already: nothing to name.
    if (owner.orgId) throw redirect({ href: deps.returnTo })
    return { email: owner.email }
  },
  head: () => ({ meta: [{ title: "Name your business · Reme" }] }),
  component: NameYourBusiness,
})

function NameYourBusiness() {
  const { email } = Route.useLoaderData()
  const returnTo = safeReturnTo(Route.useSearch().returnTo)
  const { run, pending, result } = useSubmit(nameBusiness)
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
          Signed in as <span className="text-foreground">{email}</span>. Reme
          sets up your workspace and website under this name. You can change it
          later.
        </>
      }
      footer={
        // A plain link: /sign-out signs out in its loader, and the router
        // preloads a route on hover.
        <a
          className="font-medium text-primary hover:underline"
          href="/sign-out"
        >
          Use a different account
        </a>
      }
      title="What's your business called?"
    >
      <AuthForm
        onSubmit={async (values) => {
          const outcome = await run({
            data: { businessName: values.businessName, returnTo },
          })
          if (outcome.status !== "failed") {
            window.location.assign(outcome.redirectTo)
          }
        }}
      >
        {failure ? <Alert variant="error">{failure.message}</Alert> : null}
        <Field
          autoComplete="organization"
          autoFocus
          icon={StorefrontIcon}
          id="business-name"
          label="Business name"
          maxLength={120}
          name="businessName"
          placeholder="Sparkle Cleaning Co."
          required
        />
        <SubmitButton pending={pending} pendingLabel="Setting up…">
          Continue
        </SubmitButton>
      </AuthForm>
    </AuthCard>
  )
}
