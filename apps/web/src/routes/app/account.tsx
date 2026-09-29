import { createFileRoute, Link, useLoaderData } from "@tanstack/react-router"
import { Alert } from "@workspace/ui/components/alert"
import { PageHeader } from "@workspace/ui/components/app-shell"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { useState } from "react"
import { deleteAccount } from "@/lib/api/server"

export const Route = createFileRoute("/app/account")({ component: Account })

/**
 * What the session says about the person reading it. Every value comes from the
 * layout loader, which resolved it from the sealed cookie on the server, so
 * this page holds no credential and makes no provider call of its own.
 *
 * Nothing here is editable yet. Changing a name or a password is a WorkOS call
 * per field and belongs with the account-management story, not with the guard.
 * The one write is deleting the account, behind a confirm step (ADR-035).
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
        // Never preloaded: /sign-out signs out in its loader, so a preload on
        // hover or focus would end the session.
        preload={false}
        to="/sign-out"
      >
        Sign out
      </Link>
      {owner.orgId ? <DeleteAccount /> : null}
    </>
  )
}

/**
 * Deletes the account, then signs out through `/sign-out`, which lands on the
 * home page. A refusal the owner can act on is shown as the api words it.
 */
function DeleteAccount() {
  const navigate = Route.useNavigate()
  const [step, setStep] = useState<"idle" | "confirming" | "deleting">("idle")
  const [error, setError] = useState<string | null>(null)

  const confirm = async () => {
    setStep("deleting")
    setError(null)
    try {
      const outcome = await deleteAccount()
      if (outcome.done) {
        await navigate({ to: "/sign-out" })
        return
      }
      setError(outcome.reason)
    } catch {
      setError("That did not go through. Try again.")
    }
    setStep("confirming")
  }

  if (step === "idle") {
    return (
      <Button
        className="mt-6 ml-2"
        onClick={() => setStep("confirming")}
        variant="destructive"
      >
        Delete account
      </Button>
    )
  }

  return (
    <section className="mt-6 flex flex-col gap-3 rounded-3xl border border-border px-5 py-4">
      <h2 className="font-medium">Delete your account?</h2>
      <p className="text-muted-foreground text-sm">
        You will be signed out and this sign-in will stop working. You can sign
        up again later with the same email. Your business records and website
        are not erased by this step.
      </p>
      {error ? <Alert variant="error">{error}</Alert> : null}
      <div className="flex gap-2">
        <Button
          disabled={step === "deleting"}
          onClick={confirm}
          variant="destructive"
        >
          {step === "deleting" ? "Deleting" : "Delete my account"}
        </Button>
        <Button
          disabled={step === "deleting"}
          onClick={() => {
            setStep("idle")
            setError(null)
          }}
          variant="outline"
        >
          Cancel
        </Button>
      </div>
    </section>
  )
}
