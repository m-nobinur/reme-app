import {
  EnvelopeSimpleIcon,
  StorefrontIcon,
  UserIcon,
} from "@phosphor-icons/react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Alert } from "@workspace/ui/components/alert"
import { AuthCard, AuthForm } from "@workspace/ui/components/auth-card"
import { Field } from "@workspace/ui/components/field"
import { Logo } from "@workspace/ui/components/logo"
import { PasswordField } from "@workspace/ui/components/password-field"
import { SubmitButton } from "@workspace/ui/components/submit-button"
import { PASSWORD_POLICY } from "@workspace/ui/lib/password-policy"
import { signUp } from "@/lib/auth/actions"
import { leaveIfSignedIn } from "@/lib/auth/signed-in"
import { useSubmit } from "@/lib/auth/use-submit"

export const Route = createFileRoute("/sign-up")({
  loader: leaveIfSignedIn,
  head: () => ({ meta: [{ title: "Create your account · Reme" }] }),
  component: SignUp,
})

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
      description="Your assistant is ready in minutes. Nothing goes live until you say so."
      footer={
        <>
          Already have an account?{" "}
          <Link
            className="font-medium text-primary hover:underline"
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

        <div className="flex gap-4">
          <Field
            autoComplete="given-name"
            autoFocus
            className="flex-1"
            icon={UserIcon}
            id="first-name"
            label="First name"
            name="firstName"
            placeholder="Dana"
          />
          <Field
            autoComplete="family-name"
            className="flex-1"
            icon={UserIcon}
            id="last-name"
            label="Last name"
            name="lastName"
            placeholder="Reyes"
          />
        </div>

        <Field
          autoComplete="organization"
          icon={StorefrontIcon}
          id="business-name"
          label="Business name"
          maxLength={120}
          name="businessName"
          placeholder="Sparkle Cleaning Co."
          required
        />

        <Field
          autoComplete="email"
          error={failure?.field === "email" ? failure.message : undefined}
          icon={EnvelopeSimpleIcon}
          id="email"
          inputMode="email"
          label="Email"
          name="email"
          placeholder="Enter your email"
          required
          type="email"
        />

        <PasswordField
          autoComplete="new-password"
          error={failure?.field === "password" ? failure.message : undefined}
          id="password"
          label="Password"
          minLength={PASSWORD_POLICY.minLength}
          name="password"
          placeholder={`At least ${PASSWORD_POLICY.minLength} characters`}
          required
          strength
        />

        <SubmitButton pending={pending} pendingLabel="Creating your account…">
          Create account
        </SubmitButton>

        <p className="text-center text-muted-foreground text-xs">
          By continuing you agree to our{" "}
          <Link className="underline underline-offset-4" to="/terms">
            Terms
          </Link>{" "}
          and{" "}
          <Link className="underline underline-offset-4" to="/privacy">
            Privacy Policy
          </Link>
          .
        </p>
      </AuthForm>
    </AuthCard>
  )
}
