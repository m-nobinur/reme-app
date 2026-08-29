import { createFileRoute, Link } from "@tanstack/react-router"
import { Alert } from "@workspace/ui/components/alert"
import { AuthCard, AuthForm } from "@workspace/ui/components/auth-card"
import { Field } from "@workspace/ui/components/field"
import { Logo } from "@workspace/ui/components/logo"
import { PasswordField } from "@workspace/ui/components/password-field"
import { SubmitButton } from "@workspace/ui/components/submit-button"
import { PASSWORD_POLICY } from "@workspace/ui/lib/password-policy"
import { signUp } from "@/lib/auth/actions"
import { useSubmit } from "@/lib/auth/use-submit"

export const Route = createFileRoute("/sign-up")({ component: SignUp })

function SignUp() {
  const { run, pending, result } = useSubmit(signUp)

  const failure = result?.status === "failed" ? result.failure : undefined

  return (
    <AuthCard
      brand={
        <Link to="/">
          <Logo />
        </Link>
      }
      description="Reme runs the work around the work. This takes a minute."
      footer={
        <>
          Already have an account?{" "}
          <Link
            className="text-foreground underline underline-offset-4"
            to="/sign-in"
          >
            Sign in
          </Link>
        </>
      }
      title="Create your account"
    >
      <AuthForm
        onSubmit={async (values) => {
          const outcome = await run({
            data: {
              firstName: values.firstName,
              lastName: values.lastName,
              businessName: values.businessName,
              email: values.email,
              password: values.password,
            },
          })
          if (outcome.status !== "failed") {
            window.location.assign(outcome.redirectTo)
          }
        }}
      >
        {failure && !failure.field ? (
          <Alert variant="error">{failure.message}</Alert>
        ) : null}

        <div className="flex gap-3">
          <Field
            autoComplete="given-name"
            autoFocus
            className="flex-1"
            id="first-name"
            label="First name"
            name="firstName"
            placeholder="Dana"
          />
          <Field
            autoComplete="family-name"
            className="flex-1"
            id="last-name"
            label="Last name"
            name="lastName"
            placeholder="Reyes"
          />
        </div>

        <Field
          autoComplete="organization"
          hint="This names your workspace, and it is what the assistant calls your business. You can change it later."
          id="business-name"
          label="Business name"
          maxLength={120}
          name="businessName"
          placeholder="Your cleaning business"
          required
        />

        <Field
          autoComplete="email"
          error={failure?.field === "email" ? failure.message : undefined}
          hint="Where approvals and reports go. Use one you check."
          id="email"
          inputMode="email"
          label="Work email"
          name="email"
          placeholder="name@yourbusiness.com"
          required
          type="email"
        />

        <PasswordField
          autoComplete="new-password"
          error={failure?.field === "password" ? failure.message : undefined}
          // Both halves of the policy this environment enforces, measured
          // rather than assumed: see packages/ui/src/lib/password-policy.ts.
          // There are no character-class rules, so none are claimed here.
          hint={`At least ${PASSWORD_POLICY.minLength} characters. A few unrelated words beat symbols.`}
          id="password"
          label="Password"
          minLength={PASSWORD_POLICY.minLength}
          name="password"
          placeholder="At least 10 characters"
          required
          strength
        />

        <SubmitButton pending={pending} pendingLabel="Creating your account…">
          Create account
        </SubmitButton>

        <p className="text-muted-foreground text-xs leading-relaxed">
          Creating an account sets up your workspace. Nothing is published and
          no message is sent to anyone until you approve it.
        </p>
      </AuthForm>
    </AuthCard>
  )
}
