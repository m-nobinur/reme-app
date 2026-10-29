import { StorefrontIcon } from "@phosphor-icons/react"
import { Alert } from "@workspace/ui/components/alert"
import { AuthForm } from "@workspace/ui/components/auth-card"
import { Field } from "@workspace/ui/components/field"
import { SubmitButton } from "@workspace/ui/components/submit-button"
import { nameBusiness } from "./actions"
import { useSubmit } from "./use-submit"

/**
 * The business name and Continue, on /name-your-business and on /app for a
 * session with no business, so the owner names it before any chat.
 */
export function NameBusinessForm({ returnTo }: { returnTo: string }) {
  const { run, pending, result, setResult } = useSubmit(nameBusiness)
  const failure = result?.status === "failed" ? result.failure : undefined
  return (
    // An error goes as soon as the owner types or tries again.
    <AuthForm
      className="[&_[data-slot=input]]:h-11"
      onInput={() => setResult(null)}
      onSubmit={async (values) => {
        setResult(null)
        const outcome = await run({
          data: { businessName: values.businessName, returnTo },
        })
        if (outcome.status !== "failed") {
          window.location.assign(outcome.redirectTo)
        }
      }}
    >
      {failure ? <Alert variant="error">{failure.message}</Alert> : null}
      <Field
        autoComplete="organization"
        autoFocus
        icon={StorefrontIcon}
        id="business-name"
        label="Business name"
        maxLength={120}
        name="businessName"
        placeholder="Sparkle Cleaning Co."
        // Not `required`: an empty name gets the same message, in the same
        // place, as one of spaces, rather than the browser's own bubble.
      />
      <SubmitButton pending={pending} pendingLabel="Setting up…">
        Continue
      </SubmitButton>
    </AuthForm>
  )
}
