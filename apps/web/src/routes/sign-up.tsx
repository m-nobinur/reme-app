import { createFileRoute, Link } from "@tanstack/react-router"
import { Alert } from "@workspace/ui/components/alert"
import { AuthCard, AuthForm } from "@workspace/ui/components/auth-card"
import { Button } from "@workspace/ui/components/button"
import { Field } from "@workspace/ui/components/field"
import { useState } from "react"
import { signUp } from "@/lib/auth/actions"
import { useSubmit } from "@/lib/auth/use-submit"

export const Route = createFileRoute("/sign-up")({ component: SignUp })

function SignUp() {
  const [firstName, setFirstName] = useState("")
  const [lastName, setLastName] = useState("")
  const [businessName, setBusinessName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const { run, pending, result } = useSubmit(signUp)

  const failure = result?.status === "failed" ? result.failure : undefined

  return (
    <AuthCard
      brand={<Link to="/">Reme</Link>}
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
        onSubmit={async (event) => {
          event.preventDefault()
          const outcome = await run({
            data: { firstName, lastName, businessName, email, password },
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
            onChange={(event) => setFirstName(event.target.value)}
            value={firstName}
          />
          <Field
            autoComplete="family-name"
            className="flex-1"
            id="last-name"
            label="Last name"
            onChange={(event) => setLastName(event.target.value)}
            value={lastName}
          />
        </div>

        <Field
          autoComplete="organization"
          id="business-name"
          label="Business name"
          maxLength={120}
          onChange={(event) => setBusinessName(event.target.value)}
          required
          value={businessName}
        />

        <Field
          autoComplete="email"
          error={failure?.field === "email" ? failure.message : undefined}
          id="email"
          label="Work email"
          onChange={(event) => setEmail(event.target.value)}
          required
          type="email"
          value={email}
        />

        <Field
          autoComplete="new-password"
          error={failure?.field === "password" ? failure.message : undefined}
          // The floor the environment enforces, so the browser can refuse the
          // obvious case before a round trip. Everything above it — strength,
          // reuse, breach checks — is WorkOS's answer, rendered from the
          // response rather than guessed at here.
          hint="At least 10 characters."
          id="password"
          label="Password"
          minLength={10}
          onChange={(event) => setPassword(event.target.value)}
          required
          type="password"
          value={password}
        />

        <Button disabled={pending} type="submit">
          {pending ? "Creating your account…" : "Create account"}
        </Button>
      </AuthForm>
    </AuthCard>
  )
}
