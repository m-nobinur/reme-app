import { createFileRoute, Link } from "@tanstack/react-router"
import { Alert } from "@workspace/ui/components/alert"
import { AuthCard, AuthForm } from "@workspace/ui/components/auth-card"
import { Button } from "@workspace/ui/components/button"
import { Field } from "@workspace/ui/components/field"
import { useState } from "react"
import { requestPasswordReset } from "@/lib/auth/actions"
import { useSubmit } from "@/lib/auth/use-submit"

export const Route = createFileRoute("/forgot-password")({
  component: ForgotPassword,
})

function ForgotPassword() {
  const [email, setEmail] = useState("")
  const { run, pending, result } = useSubmit(requestPasswordReset)

  const sent = result && "sent" in result
  const failure = result && "failure" in result ? result.failure : undefined

  return (
    <AuthCard
      brand={<Link to="/">Reme</Link>}
      description={
        sent
          ? undefined
          : "We will email you a link to set a new one. The link is good for fifteen minutes."
      }
      footer={
        <Link
          className="text-foreground underline underline-offset-4"
          to="/sign-in"
        >
          Back to sign in
        </Link>
      }
      title={sent ? "Check your email" : "Reset your password"}
    >
      {sent ? (
        // Deliberately says nothing about whether that address has an account.
        // WorkOS answers 404 for an unknown address and the server function
        // swallows it, so this page cannot be used to find out who is a
        // customer.
        <Alert variant="success">
          If there is an account for {email}, a reset link is on its way. It
          expires in fifteen minutes.
        </Alert>
      ) : (
        <AuthForm
          onSubmit={async (event) => {
            event.preventDefault()
            await run({ data: { email } })
          }}
        >
          {failure ? <Alert variant="error">{failure.message}</Alert> : null}

          <Field
            autoComplete="email"
            autoFocus
            id="email"
            label="Email"
            onChange={(event) => setEmail(event.target.value)}
            required
            type="email"
            value={email}
          />

          <Button disabled={pending} type="submit">
            {pending ? "Sending…" : "Email me a reset link"}
          </Button>
        </AuthForm>
      )}
    </AuthCard>
  )
}
