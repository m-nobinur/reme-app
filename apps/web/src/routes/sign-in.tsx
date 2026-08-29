import { GoogleLogoIcon, MicrosoftOutlookLogoIcon } from "@phosphor-icons/react"
import { createFileRoute, Link, useRouter } from "@tanstack/react-router"
import { Alert } from "@workspace/ui/components/alert"
import { AuthCard, AuthForm } from "@workspace/ui/components/auth-card"
import { buttonVariants } from "@workspace/ui/components/button"
import { Field } from "@workspace/ui/components/field"
import { Logo } from "@workspace/ui/components/logo"
import { PasswordField } from "@workspace/ui/components/password-field"
import { SubmitButton } from "@workspace/ui/components/submit-button"
import { signIn } from "@/lib/auth/actions"
import { safeReturnTo } from "@/lib/auth/redirect-target"
import { useSubmit } from "@/lib/auth/use-submit"

const CALLBACK_ERROR_TEXT = {
  cancelled: "That sign-in was cancelled. Nothing was changed.",
  callback: "We could not finish that sign-in. Start it again from this page.",
  provider: "That sign-in method is not available here.",
} as const

type CallbackError = keyof typeof CALLBACK_ERROR_TEXT
const CALLBACK_ERRORS = new Set<string>(Object.keys(CALLBACK_ERROR_TEXT))

/**
 * Both keys optional, and written out rather than inferred. A validator that
 * infers `{ returnTo: string | undefined }` gives a *required* key holding an
 * undefined, which makes `search` mandatory on every `<Link to="/sign-in">` in
 * the flow. `?:` is what makes the link work with no search at all.
 */
type SignInSearch = { returnTo?: string; error?: CallbackError }

export const Route = createFileRoute("/sign-in")({
  // Validated here rather than read raw in the component, so a crafted
  // ?returnTo= cannot become a redirect off this origin. The server function
  // checks it again, because the browser is not the boundary.
  validateSearch: (search: Record<string, unknown>): SignInSearch => ({
    returnTo:
      search.returnTo === undefined ? undefined : safeReturnTo(search.returnTo),
    // Set by the OAuth routes when they send someone back here. Narrowed to a
    // known set so the page cannot be made to render arbitrary text from a link.
    error: CALLBACK_ERRORS.has(search.error as string)
      ? (search.error as CallbackError)
      : undefined,
  }),
  component: SignIn,
})

/** The providers this environment has enabled, checked against it on 2026-08-27. */
const SOCIAL = [
  {
    provider: "GoogleOAuth",
    label: "Continue with Google",
    icon: GoogleLogoIcon,
  },
  {
    provider: "MicrosoftOAuth",
    label: "Continue with Microsoft",
    icon: MicrosoftOutlookLogoIcon,
  },
] as const

function SignIn() {
  const { returnTo = "/app", error } = Route.useSearch()
  const router = useRouter()
  const { run, pending, result } = useSubmit(signIn)

  const failure = result?.status === "failed" ? result.failure : undefined

  return (
    <AuthCard
      brand={
        <Link to="/">
          <Logo />
        </Link>
      }
      description="Use the email your account was set up with."
      footer={
        <>
          No account yet?{" "}
          <Link
            className="text-foreground underline underline-offset-4"
            to="/sign-up"
          >
            Create one
          </Link>
        </>
      }
      title="Sign in"
    >
      <AuthForm
        onSubmit={async (values) => {
          const outcome = await run({
            data: {
              email: values.email,
              password: values.password,
              returnTo,
            },
          })
          if (outcome.status !== "failed") {
            // A full navigation, not a client-side one: the session cookie was
            // set on this response and the authed layout has to be loaded with
            // it in hand.
            window.location.assign(outcome.redirectTo)
            return
          }
          await router.invalidate()
        }}
      >
        {error ? (
          <Alert variant="error">{CALLBACK_ERROR_TEXT[error]}</Alert>
        ) : null}
        {failure && !failure.field ? (
          <Alert variant="error">{failure.message}</Alert>
        ) : null}

        <Field
          autoComplete="email"
          autoFocus
          error={failure?.field === "email" ? failure.message : undefined}
          id="email"
          inputMode="email"
          label="Email"
          name="email"
          placeholder="name@yourbusiness.com"
          required
          type="email"
        />

        <PasswordField
          autoComplete="current-password"
          error={failure?.field === "password" ? failure.message : undefined}
          hint={
            <Link
              className="underline underline-offset-4"
              to="/forgot-password"
            >
              Forgotten your password?
            </Link>
          }
          id="password"
          label="Password"
          name="password"
          placeholder="Your password"
        />

        <SubmitButton pending={pending} pendingLabel="Signing in…">
          Sign in
        </SubmitButton>
      </AuthForm>

      <div className="mt-6 flex items-center gap-3">
        <span aria-hidden className="h-px flex-1 bg-border" />
        <span className="text-muted-foreground text-xs">or</span>
        <span aria-hidden className="h-px flex-1 bg-border" />
      </div>

      <div className="mt-6 flex flex-col gap-2">
        {SOCIAL.map((option) => (
          <a
            className={buttonVariants({
              variant: "outline",
              className: "w-full",
            })}
            // A plain link, not a fetch: the provider redirect has to be a
            // top-level navigation, and the state cookie is set on this
            // response by the route that answers it.
            href={`/api/auth/social?provider=${option.provider}&returnTo=${encodeURIComponent(returnTo)}`}
            key={option.provider}
          >
            <option.icon aria-hidden />
            {option.label}
          </a>
        ))}
      </div>
    </AuthCard>
  )
}
