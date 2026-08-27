import { createFileRoute, Link, redirect } from "@tanstack/react-router"
import { Alert } from "@workspace/ui/components/alert"
import { AuthCard, AuthForm } from "@workspace/ui/components/auth-card"
import { Button } from "@workspace/ui/components/button"
import { CodeInput } from "@workspace/ui/components/code-input"
import { Field } from "@workspace/ui/components/field"
import { LoadingState } from "@workspace/ui/components/loading-state"
import { useEffect, useState } from "react"
import {
  confirmMfa,
  getPendingAuth,
  startMfaChallenge,
} from "@/lib/auth/actions"
import { useSubmit } from "@/lib/auth/use-submit"

export const Route = createFileRoute("/mfa")({
  loader: async () => {
    const pending = await getPendingAuth()
    if (!pending) {
      throw redirect({ to: "/sign-in" })
    }
    return pending
  },
  component: MfaChallenge,
})

function MfaChallenge() {
  const [code, setCode] = useState("")
  const challenge = useSubmit(startMfaChallenge)
  const verify = useSubmit(confirmMfa)

  // The challenge has to exist before a code can be checked against it, and it
  // is started here rather than in the loader: the loader runs again on every
  // client navigation back to this route, and each run would spend a challenge.
  // biome-ignore lint/correctness/useExhaustiveDependencies: this must run once per mount, and `challenge.run` is stable only per render
  useEffect(() => {
    void challenge.run(undefined)
  }, [])

  const started = challenge.result && "challenged" in challenge.result
  const challengeFailure =
    challenge.result && "failure" in challenge.result
      ? challenge.result.failure
      : undefined
  const failure =
    verify.result?.status === "failed" ? verify.result.failure : undefined

  return (
    <AuthCard
      brand={<Link to="/">Reme</Link>}
      description="Open your authenticator app and enter the code it shows."
      footer={
        <Link
          className="text-foreground underline underline-offset-4"
          to="/sign-in"
        >
          Use a different account
        </Link>
      }
      title="Two-step verification"
    >
      {challenge.pending && !started ? (
        <LoadingState label="Starting the check" />
      ) : null}

      {challengeFailure ? (
        <Alert variant="error">{challengeFailure.message}</Alert>
      ) : null}

      {started ? (
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
            {verify.pending ? "Checking…" : "Verify"}
          </Button>
        </AuthForm>
      ) : null}
    </AuthCard>
  )
}
