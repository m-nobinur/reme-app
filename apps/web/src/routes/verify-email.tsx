import { createFileRoute, Link, redirect } from "@tanstack/react-router"
import { Alert } from "@workspace/ui/components/alert"
import { AuthCard, AuthForm } from "@workspace/ui/components/auth-card"
import { Button } from "@workspace/ui/components/button"
import { CodeInput } from "@workspace/ui/components/code-input"
import { Field } from "@workspace/ui/components/field"
import { useState } from "react"
import {
  getPendingAuth,
  resendVerification,
  verifyEmail,
} from "@/lib/auth/actions"
import { useSubmit } from "@/lib/auth/use-submit"

export const Route = createFileRoute("/verify-email")({
  // In the loader, not `beforeLoad`: `beforeLoad` also runs on the client
  // during hydration, where the sealed flow cookie is not readable.
  loader: async () => {
    const pending = await getPendingAuth()
    if (!pending) {
      throw redirect({ to: "/sign-in" })
    }
    return pending
  },
  component: VerifyEmail,
})

function VerifyEmail() {
  const pending = Route.useLoaderData()
  const [code, setCode] = useState("")
  const verify = useSubmit(verifyEmail)
  const resend = useSubmit(resendVerification)

  const failure =
    verify.result?.status === "failed" ? verify.result.failure : undefined
  const resendFailure = resend.result?.failure

  return (
    <AuthCard
      brand={<Link to="/">Reme</Link>}
      description={`We sent a six-digit code to ${pending.email}. It expires shortly.`}
      footer={
        <Link
          className="text-foreground underline underline-offset-4"
          to="/sign-in"
        >
          Use a different account
        </Link>
      }
      title="Check your email"
    >
      <AuthForm
        onSubmit={async (event) => {
          event.preventDefault()
          const outcome = await verify.run({ data: { code } })
          if (outcome.status !== "failed") {
            window.location.assign(outcome.redirectTo)
          }
        }}
      >
        {failure && !failure.field ? (
          <Alert variant="error">{failure.message}</Alert>
        ) : null}
        {resend.result?.sent ? (
          <Alert variant="success">
            A new code is on its way. The older one no longer works.
          </Alert>
        ) : null}
        {resendFailure ? (
          <Alert variant="error">{resendFailure.message}</Alert>
        ) : null}

        <Field
          error={failure?.field === "code" ? failure.message : undefined}
          id="code"
          label="Six-digit code"
        >
          <CodeInput
            aria-invalid={failure?.field === "code" ? true : undefined}
            autoFocus
            id="code"
            onChange={(event) => setCode(event.target.value)}
            required
            value={code}
          />
        </Field>

        <Button disabled={verify.pending || code.length < 6} type="submit">
          {verify.pending ? "Checking…" : "Verify email"}
        </Button>

        <Button
          disabled={resend.pending}
          onClick={() => resend.run(undefined)}
          type="button"
          variant="ghost"
        >
          {resend.pending ? "Sending…" : "Send a new code"}
        </Button>
      </AuthForm>
    </AuthCard>
  )
}
