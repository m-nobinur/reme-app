import { createFileRoute, Link, redirect } from "@tanstack/react-router"
import { AuthCard } from "@workspace/ui/components/auth-card"
import { Logo } from "@workspace/ui/components/logo"
import { hasBusiness } from "@/lib/api/server"
import { sessionRefreshes } from "@/lib/auth/actions"
import { NameBusinessForm } from "@/lib/auth/name-business-form"
import { safeReturnTo } from "@/lib/auth/redirect-target"
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
    // A session that cannot refresh would fail only on Continue, after the
    // owner typed a name: send them to sign in now instead.
    if (!(await sessionRefreshes())) {
      throw redirect({
        to: "/sign-in",
        search: { returnTo: location.href, error: "ended" },
      })
    }
    // One already: nothing to name. Asked of the api, since a WorkOS
    // organization alone is not a business we hold.
    if (await hasBusiness()) throw redirect({ href: deps.returnTo })
    return { email: owner.email }
  },
  head: () => ({ meta: [{ title: "Name your business · Reme" }] }),
  component: NameYourBusiness,
})

function NameYourBusiness() {
  const { email } = Route.useLoaderData()
  const returnTo = safeReturnTo(Route.useSearch().returnTo)

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
      <NameBusinessForm returnTo={returnTo} />
    </AuthCard>
  )
}
