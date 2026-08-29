import { createFileRoute, Link } from "@tanstack/react-router"
import { Alert } from "@workspace/ui/components/alert"
import { AuthCard, AuthForm } from "@workspace/ui/components/auth-card"
import { buttonVariants } from "@workspace/ui/components/button"
import { Logo } from "@workspace/ui/components/logo"
import { PasswordField } from "@workspace/ui/components/password-field"
import { SubmitButton } from "@workspace/ui/components/submit-button"
import { PASSWORD_POLICY } from "@workspace/ui/lib/password-policy"
import { useState } from "react"
import { resetPassword } from "@/lib/auth/actions"
import { useSubmit } from "@/lib/auth/use-submit"

/** Optional, so `/reset-password` with no token renders the dead-link page. */
type ResetSearch = { token?: string }

export const Route = createFileRoute("/reset-password")({
  validateSearch: (search: Record<string, unknown>): ResetSearch => ({
    token:
      typeof search.token === "string" ? search.token.slice(0, 256) : undefined,
  }),
  component: ResetPassword,
})

function ResetPassword() {
  const { token = "" } = Route.useSearch()
  const [mismatch, setMismatch] = useState<string | undefined>()
  const { run, pending, result } = useSubmit(resetPassword)

  const done = result && "reset" in result
  const failure = result && "failure" in result ? result.failure : undefined
  // A link with no token at all never reaches the server: there is nothing to
  // try. This is the case where someone copies the email text instead of
  // following the link.
  const linkIsDead = !token || failure?.code === "reset_link_dead"

  if (done) {
    return (
      <AuthCard
        brand={
          <Link to="/">
            <Logo />
          </Link>
        }
        title="Your password is changed"
      >
        <Alert variant="success">
          You can sign in with your new password now. Any other devices that
          were signed in stay signed in.
        </Alert>
        <Link
          className={buttonVariants({ className: "mt-6 w-full" })}
          to="/sign-in"
        >
          Sign in
        </Link>
      </AuthCard>
    )
  }

  if (linkIsDead) {
    return (
      <AuthCard
        brand={
          <Link to="/">
            <Logo />
          </Link>
        }
        description="Reset links last fifteen minutes and work once."
        title="This link no longer works"
      >
        <Alert variant="error">
          {failure?.message ??
            "This link has expired or has already been used. Ask for a new one."}
        </Alert>
        {/* The default variant, not outline. This is the only thing to do on
            this page, and in dark mode the outline variant is a transparent
            box with a 10% border, which reads as a caption rather than as the
            way forward. */}
        <Link
          className={buttonVariants({ className: "mt-6 w-full" })}
          to="/forgot-password"
        >
          Send me a new link
        </Link>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      brand={
        <Link to="/">
          <Logo />
        </Link>
      }
      description="Pick something you have not used here before."
      footer={
        <Link
          className="text-foreground underline underline-offset-4"
          to="/sign-in"
        >
          Back to sign in
        </Link>
      }
      title="Set a new password"
    >
      <AuthForm
        onSubmit={async (values) => {
          if (values.password !== values.confirmation) {
            setMismatch("The two passwords do not match.")
            return
          }
          setMismatch(undefined)
          await run({ data: { token, password: values.password } })
        }}
      >
        {failure && !failure.field ? (
          <Alert variant="error">{failure.message}</Alert>
        ) : null}

        <PasswordField
          autoComplete="new-password"
          autoFocus
          error={failure?.field === "newPassword" ? failure.message : undefined}
          hint={`At least ${PASSWORD_POLICY.minLength} characters. A few unrelated words beat symbols.`}
          id="password"
          label="New password"
          minLength={PASSWORD_POLICY.minLength}
          name="password"
          placeholder="At least 10 characters"
          required
          strength
        />

        <PasswordField
          autoComplete="new-password"
          error={mismatch}
          id="confirmation"
          label="New password again"
          minLength={PASSWORD_POLICY.minLength}
          name="confirmation"
          // Cleared as soon as they start fixing it, rather than sitting there
          // contradicting what is now on screen.
          onChange={() => setMismatch(undefined)}
          placeholder="Type it once more"
          required
        />

        <SubmitButton pending={pending} pendingLabel="Saving…">
          Change password
        </SubmitButton>
      </AuthForm>
    </AuthCard>
  )
}
