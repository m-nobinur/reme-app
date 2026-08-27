import { createFileRoute, Link, useLoaderData } from "@tanstack/react-router"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { buttonVariants } from "@workspace/ui/components/button"

export const Route = createFileRoute("/app/account")({ component: Account })

/**
 * What the session says about the person reading it. Every value comes from the
 * layout loader, which resolved it from the sealed cookie on the server, so
 * this page holds no credential and makes no provider call of its own.
 *
 * Nothing here is editable yet. Changing a name or a password is a WorkOS call
 * per field and belongs with the account-management story, not with the guard.
 */
function Account() {
  const { owner } = useLoaderData({ from: "/app" })

  const rows: Array<{ label: string; value: string }> = [
    { label: "Name", value: owner.name || "Not set" },
    { label: "Email", value: owner.email },
    { label: "Organisation", value: owner.orgId ?? "None yet" },
    // A role is issued by an organisation, so it stays empty until one exists.
    { label: "Role", value: owner.role ?? "None yet" },
  ]

  return (
    <>
      <PageHeader
        description="The account this session belongs to."
        title="Account"
      />
      <dl className="divide-y divide-border rounded-3xl border border-border">
        {rows.map((row) => (
          <div
            className="flex flex-col gap-1 px-5 py-4 sm:flex-row sm:items-baseline sm:gap-6"
            key={row.label}
          >
            <dt className="text-muted-foreground text-sm sm:w-40 sm:shrink-0">
              {row.label}
            </dt>
            <dd className="min-w-0 break-words">{row.value}</dd>
          </div>
        ))}
      </dl>
      <Link
        className={buttonVariants({ variant: "outline", className: "mt-6" })}
        to="/sign-out"
      >
        Sign out
      </Link>
    </>
  )
}
