import { createFileRoute, Link, redirect } from "@tanstack/react-router"
import { Alert } from "@workspace/ui/components/alert"
import { AuthCard, AuthForm } from "@workspace/ui/components/auth-card"
import { CodeInput } from "@workspace/ui/components/code-input"
import { Field } from "@workspace/ui/components/field"
import { Logo } from "@workspace/ui/components/logo"
import { SubmitButton } from "@workspace/ui/components/submit-button"
import { useState } from "react"
import {
  getPendingAuth,
  resendVerification,
  verifyEmail,
} from "@/lib/auth/actions"
import { CODE_LENGTH, codeProblem } from "@/lib/auth/code"
import { leaveIfSignedIn } from "@/lib/auth/signed-in"
import { useCooldown } from "@/lib/auth/use-cooldown"
import { useSubmit } from "@/lib/auth/use-submit"

export const Route = createFileRoute("/verify-email")({
  // In the loader, not `beforeLoad`: `beforeLoad` also runs on the client
  // during hydration, where the sealed flow cookie is not readable.
  loader: async () => {
    await leaveIfSignedIn()
    const pending = await getPendingAuth()
    if (!pending) {
      throw redirect({ to: "/sign-in" })
    }
    return pending
  },
  head: () => ({ meta: [{ title: "Verify your email · Reme" }] }),
  component: VerifyEmail,
})

function VerifyEmail() {
  const pending = Route.useLoaderData()
  const [localProblem, setLocalProblem] = useState<string | undefined>()
  const verify = useSubmit(verifyEmail)
  const resend = useSubmit(resendVerification)
  const cooldown = useCooldown("verify-email-resend-until")

  const failure =
    verify.result?.status === "failed" ? verify.result.failure : undefined
  const resendFailure = resend.result?.failure
  const codeError =
    localProblem ?? (failure?.field === "code" ? failure.message : undefined)

  return (
    <AuthCard
      brand={
        <Link to="/">
          <Logo />
        </Link>
      }
      description={
        <>
          We sent a {CODE_LENGTH}-digit code to{" "}
          <span className="text-foreground">{pending.email}</span>. Enter it
          here to finish setting up your account.
        </>
      }
      footer={
        <Link
          className="font-medium text-primary hover:underline"
          to="/sign-in"
        >
          Use a different account
        </Link>
      }
      title="Check your email"
    >
      <AuthForm
        onSubmit={async (values) => {
          const problem = codeProblem(values.code)
          setLocalProblem(problem)
          if (problem) {
            return
          }
          const outcome = await verify.run({ data: { code: values.code } })
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

        <Field error={codeError} id="code" label="Verification code">
          {(wiring) => (
            <CodeInput
              {...wiring}
              autoFocus
              name="code"
              onChange={() => setLocalProblem(undefined)}
            />
          )}
        </Field>

        <SubmitButton pending={verify.pending} pendingLabel="Checking…">
          Verify email
        </SubmitButton>

        <p className="text-center text-muted-foreground text-sm">
          {cooldown.secondsLeft > 0 ? (
            <>
              Didn't receive the code? Resend in{" "}
              <span className="tabular-nums">{cooldown.secondsLeft}s</span>
            </>
          ) : (
            <>
              Didn't receive the code?{" "}
              <button
                className="font-medium text-primary hover:underline disabled:opacity-50"
                disabled={resend.pending}
                onClick={async () => {
                  await resend.run(undefined)
                  cooldown.start()
                }}
                type="button"
              >
                {resend.pending ? "Sending…" : "Resend code"}
              </button>
            </>
          )}
        </p>
      </AuthForm>
    </AuthCard>
  )
}
