import { createFileRoute, Link, redirect } from "@tanstack/react-router"
import { Alert } from "@workspace/ui/components/alert"
import { AuthCard, AuthForm } from "@workspace/ui/components/auth-card"
import { Button } from "@workspace/ui/components/button"
import { CodeInput } from "@workspace/ui/components/code-input"
import { Field } from "@workspace/ui/components/field"
import { LoadingState } from "@workspace/ui/components/loading-state"
import { Logo } from "@workspace/ui/components/logo"
import { SubmitButton } from "@workspace/ui/components/submit-button"
import { useEffect, useState } from "react"
import {
  confirmMfa,
  getPendingAuth,
  startMfaEnrolment,
} from "@/lib/auth/actions"
import { codeProblem } from "@/lib/auth/code"
import { useSubmit } from "@/lib/auth/use-submit"

export const Route = createFileRoute("/mfa-setup")({
  loader: async () => {
    const pending = await getPendingAuth()
    if (!pending) {
      throw redirect({ to: "/sign-in" })
    }
    return pending
  },
  head: () => ({ meta: [{ title: "Set up two-step verification · Reme" }] }),
  component: MfaSetup,
})

function MfaSetup() {
  const [showSecret, setShowSecret] = useState(false)
  const [localProblem, setLocalProblem] = useState<string | undefined>()
  const enrol = useSubmit(startMfaEnrolment)
  const verify = useSubmit(confirmMfa)

  // Once per mount. Each call mints a new factor and a new challenge, so
  // running it in the loader would mint one on every navigation back here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: this must run once per mount, and `enrol.run` is stable only per render
  useEffect(() => {
    void enrol.run(undefined)
  }, [])

  const enrolment =
    enrol.result && "qrCode" in enrol.result ? enrol.result : undefined
  const enrolFailure =
    enrol.result && "failure" in enrol.result ? enrol.result.failure : undefined
  const failure =
    verify.result?.status === "failed" ? verify.result.failure : undefined
  const codeError =
    localProblem ?? (failure?.field === "code" ? failure.message : undefined)

  return (
    <AuthCard
      brand={
        <Link to="/">
          <Logo />
        </Link>
      }
      description="An authenticator app gives a fresh code every thirty seconds, so a stolen password is not enough on its own."
      footer={
        <Link
          className="font-medium text-primary hover:underline"
          to="/sign-in"
        >
          Use a different account
        </Link>
      }
      title="Set up two-step verification"
    >
      {enrol.pending && !enrolment ? (
        <LoadingState label="Preparing your code" />
      ) : null}

      {enrolFailure ? (
        <Alert variant="error">{enrolFailure.message}</Alert>
      ) : null}

      {enrolment ? (
        <>
          <ol className="flex flex-col gap-4 text-sm">
            <li className="flex gap-3">
              <span
                aria-hidden
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-xs"
              >
                1
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium">Scan this in your authenticator</p>
                <p className="mt-0.5 text-muted-foreground">
                  Google Authenticator, 1Password, Authy and Bitwarden all work.
                </p>
                <div className="mt-3 flex flex-col items-center gap-3">
                  {/* WorkOS returns the QR code as a data: PNG, so there is no
                      image host involved and nothing to load across the
                      network.

                      `bg-scan-surface`, not `bg-card`: the PNG has a
                      transparent background, and on the dark card its modules
                      sat on near-black, where no camera can read them. That
                      token is the one colour in the system that does not flip
                      with the theme, because dark-on-light is what a QR scanner
                      requires rather than what a design prefers. */}
                  <img
                    alt="QR code for your authenticator app"
                    className="size-44 rounded-2xl bg-scan-surface p-2"
                    src={enrolment.qrCode}
                  />
                  {showSecret ? (
                    <p className="w-full break-all rounded-2xl bg-muted px-3 py-2 text-center font-mono text-xs">
                      {enrolment.secret}
                    </p>
                  ) : (
                    <Button
                      onClick={() => setShowSecret(true)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Cannot scan it? Show the key instead
                    </Button>
                  )}
                </div>
              </div>
            </li>
            <li className="flex gap-3">
              <span
                aria-hidden
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-xs"
              >
                2
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-medium">Type the code it shows</p>
                <p className="mt-0.5 text-muted-foreground">
                  That proves the app and this account agree before we rely on
                  it.
                </p>
              </div>
            </li>
          </ol>

          <AuthForm
            className="mt-6"
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

            <Field error={codeError} id="code" label="Code from the app">
              {(wiring) => (
                <CodeInput
                  {...wiring}
                  name="code"
                  onChange={() => setLocalProblem(undefined)}
                />
              )}
            </Field>

            <SubmitButton pending={verify.pending} pendingLabel="Confirming…">
              Confirm and sign in
            </SubmitButton>
          </AuthForm>
        </>
      ) : null}
    </AuthCard>
  )
}
