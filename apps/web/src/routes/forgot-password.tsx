import { EnvelopeSimpleIcon } from "@phosphor-icons/react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Alert } from "@workspace/ui/components/alert"
import { AuthCard, AuthForm } from "@workspace/ui/components/auth-card"
import { Field } from "@workspace/ui/components/field"
import { Logo } from "@workspace/ui/components/logo"
import { SubmitButton } from "@workspace/ui/components/submit-button"
import { useState } from "react"
import { requestPasswordReset } from "@/lib/auth/actions"
import { useSubmit } from "@/lib/auth/use-submit"

export const Route = createFileRoute("/forgot-password")({
  head: () => ({ meta: [{ title: "Reset your password · Reme" }] }),
  component: ForgotPassword,
})

function ForgotPassword() {
  // Only so the confirmation can name the address back. It is set on submit
  // rather than on every keystroke, because the field itself is uncontrolled.
  const [sentTo, setSentTo] = useState("")
  const { run, pending, result } = useSubmit(requestPasswordReset)

  const sent = result && "sent" in result
  const failure = result && "failure" in result ? result.failure : undefined

  return (
    <AuthCard
      brand={
        <Link to="/">
          <Logo />
        </Link>
      }
      description={
        sent
          ? undefined
          : "Enter your email and we will send you a link to set a new one."
      }
      footer={
        <Link
          className="font-medium text-primary hover:underline"
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
        <div className="flex flex-col gap-4">
          <Alert variant="success">
            If there is an account for {sentTo}, a reset link is on its way. It
            expires in fifteen minutes.
          </Alert>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Nothing arrived? Check the spam folder, then try again in a minute.
            The link opens a page here where you set the new password.
          </p>
        </div>
      ) : (
        <AuthForm
          onSubmit={async (values) => {
            setSentTo(values.email)
            await run({ data: { email: values.email } })
          }}
        >
          {failure ? <Alert variant="error">{failure.message}</Alert> : null}

          <Field
            autoComplete="email"
            autoFocus
            icon={EnvelopeSimpleIcon}
            id="email"
            inputMode="email"
            label="Email"
            name="email"
            placeholder="Enter your email"
            required
            type="email"
          />

          <SubmitButton pending={pending} pendingLabel="Sending…">
            Email me a reset link
          </SubmitButton>
        </AuthForm>
      )}
    </AuthCard>
  )
}
