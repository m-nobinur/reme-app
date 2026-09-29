import { createFileRoute, Link } from "@tanstack/react-router"
import { Alert } from "@workspace/ui/components/alert"
import { AuthCard, AuthForm } from "@workspace/ui/components/auth-card"
import { Button } from "@workspace/ui/components/button"
import { CodeInput } from "@workspace/ui/components/code-input"
import { Field } from "@workspace/ui/components/field"
import { Logo } from "@workspace/ui/components/logo"
import { SubmitButton } from "@workspace/ui/components/submit-button"
import { useState } from "react"
import { sendSignInCode, signInWithCode } from "@/lib/auth/actions"
import { CODE_LENGTH, codeProblem } from "@/lib/auth/code"
import { safeReturnTo } from "@/lib/auth/redirect-target"
import { useSubmit } from "@/lib/auth/use-submit"

type SignInCodeSearch = { returnTo?: string }

export const Route = createFileRoute("/sign-in-code")({
  // The same rule as /sign-in; the server function checks it again.
  validateSearch: (search: Record<string, unknown>): SignInCodeSearch => ({
    returnTo:
      search.returnTo === undefined ? undefined : safeReturnTo(search.returnTo),
  }),
  head: () => ({ meta: [{ title: "Sign in with a code · Reme" }] }),
  component: SignInCode,
})

function SignInCode() {
  const { returnTo = "/app" } = Route.useSearch()
  // Set once the code is sent. It is the only state between the two steps:
  // WorkOS authenticates the code against the address, not against a token.
  const [email, setEmail] = useState("")
  const [localProblem, setLocalProblem] = useState<string | undefined>()
  const send = useSubmit(sendSignInCode)
  const verify = useSubmit(signInWithCode)

  const sent = Boolean(email)
  const sendFailure =
    send.result && "failure" in send.result ? send.result.failure : undefined
  const failure =
    verify.result?.status === "failed" ? verify.result.failure : undefined
  const codeError =
    localProblem ?? (failure?.field === "code" ? failure.message : undefined)

  const signInLink = (
    <Link
      className="font-medium text-foreground underline underline-offset-4"
      search={{ returnTo }}
      to="/sign-in"
    >
      Sign in with a password instead
    </Link>
  )

  if (!sent) {
    return (
      <AuthCard
        brand={
          <Link to="/">
            <Logo />
          </Link>
        }
        description={`We will email you a ${CODE_LENGTH}-digit code. It works once and expires in ten minutes.`}
        footer={signInLink}
        title="Sign in with a code"
      >
        <AuthForm
          onSubmit={async (values) => {
            const outcome = await send.run({ data: { email: values.email } })
            if ("sent" in outcome) {
              setEmail(values.email)
            }
          }}
        >
          {sendFailure ? (
            <Alert variant="error">{sendFailure.message}</Alert>
          ) : null}

          <Field
            autoComplete="email"
            autoFocus
            id="email"
            inputMode="email"
            label="Email"
            name="email"
            placeholder="name@yourbusiness.com"
            required
            type="email"
          />

          <SubmitButton pending={send.pending} pendingLabel="Sending…">
            Email me a code
          </SubmitButton>
        </AuthForm>
      </AuthCard>
    )
  }

  return (
    <AuthCard
      brand={
        <Link to="/">
          <Logo />
        </Link>
      }
      // Says nothing about whether the address has an account, so this page
      // cannot be used to find out who is a customer.
      description={
        <>
          If <span className="text-foreground">{email}</span> can sign in here,
          a {CODE_LENGTH}-digit code is on its way. Enter it to continue.
        </>
      }
      footer={signInLink}
      title="Check your email"
    >
      <AuthForm
        onSubmit={async (values) => {
          const problem = codeProblem(values.code)
          setLocalProblem(problem)
          if (problem) {
            return
          }
          const outcome = await verify.run({
            data: { email, code: values.code, returnTo },
          })
          if (outcome.status !== "failed") {
            // A full navigation: the session cookie was set on this response.
            window.location.assign(outcome.redirectTo)
          }
        }}
      >
        {failure && !failure.field ? (
          <Alert variant="error">{failure.message}</Alert>
        ) : null}

        <Field
          error={codeError}
          hint="It is in the email we just sent. Codes are digits only."
          id="code"
          label={`${CODE_LENGTH}-digit code`}
        >
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
          Sign in
        </SubmitButton>

        <Button
          onClick={() => {
            setEmail("")
            send.setResult(null)
            verify.setResult(null)
          }}
          type="button"
          variant="ghost"
        >
          Use a different email
        </Button>
      </AuthForm>
    </AuthCard>
  )
}
