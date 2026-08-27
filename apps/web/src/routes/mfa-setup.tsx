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
  startMfaEnrolment,
} from "@/lib/auth/actions"
import { useSubmit } from "@/lib/auth/use-submit"

export const Route = createFileRoute("/mfa-setup")({
  loader: async () => {
    const pending = await getPendingAuth()
    if (!pending) {
      throw redirect({ to: "/sign-in" })
    }
    return pending
  },
  component: MfaSetup,
})

function MfaSetup() {
  const [code, setCode] = useState("")
  const [showSecret, setShowSecret] = useState(false)
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

  return (
    <AuthCard
      brand={<Link to="/">Reme</Link>}
      description="Scan this with an authenticator app, then type the code it shows to verify it worked."
      footer={
        <Link
          className="text-foreground underline underline-offset-4"
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
          <div className="flex flex-col items-center gap-3">
            {/* WorkOS returns the QR code as a data: PNG, so there is no image
                host involved and nothing to load across the network. */}
            <img
              alt="QR code for your authenticator app"
              className="size-44 rounded-2xl bg-card p-2"
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

          <AuthForm
            className="mt-6"
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
              label="Code from the app"
            >
              <CodeInput
                aria-invalid={failure?.field === "code" ? true : undefined}
                id="code"
                onChange={(event) => setCode(event.target.value)}
                required
                value={code}
              />
            </Field>

            <Button disabled={verify.pending || code.length < 6} type="submit">
              {verify.pending ? "Confirming…" : "Confirm and sign in"}
            </Button>
          </AuthForm>
        </>
      ) : null}
    </AuthCard>
  )
}
