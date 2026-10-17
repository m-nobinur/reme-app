import { XIcon } from "@phosphor-icons/react"
import { Alert } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { useEffect, useState } from "react"

/** What `/api/google/callback` puts in `?google=` when it sends the owner back. */
const NOTICES = {
  connected: {
    variant: "success",
    text: "Google is connected. I'll register your site and tell you when it's in.",
  },
  scopes_missing: {
    variant: "error",
    text: "Google gave me read access but not permission to add your site. Tap Connect Google again and leave both boxes ticked.",
  },
  cancelled: { variant: "info", text: "Google was not connected." },
  failed: {
    variant: "error",
    text: "That didn't work. Try Connect Google again.",
  },
  unavailable: {
    variant: "info",
    text: "Connecting Google isn't available yet.",
  },
} as const

export type GoogleResult = keyof typeof NOTICES

/** The result the page was opened with, or nothing for any other value. */
export const googleResult = (value: unknown): GoogleResult | undefined =>
  typeof value === "string" && Object.hasOwn(NOTICES, value)
    ? (value as GoogleResult)
    : undefined

/**
 * Keeps the callback's result for the page and asks `clear` to drop it from
 * the address, so a reload or a shared link does not repeat it. Dismissing
 * hides it.
 */
export function useGoogleResult(
  result: GoogleResult | undefined,
  clear: () => void
) {
  const [shown, setShown] = useState(result)
  useEffect(() => {
    if (!result) return
    setShown(result)
    clear()
  }, [result, clear])
  return [shown, () => setShown(undefined)] as const
}

/**
 * The one line the app says after Google's screen. It floats over the top of
 * the page without taking room from it, and stays until it is dismissed: two
 * of its lines tell the owner what to do next.
 */
export function GoogleNotice({
  result,
  onDismiss,
}: {
  result: GoogleResult | undefined
  onDismiss: () => void
}) {
  if (!result) return null
  const { variant, text } = NOTICES[result]
  return (
    <div className="sticky top-0 z-10 h-0 px-4" data-slot="google-notice">
      <Alert className="mx-auto mt-2 max-w-md shadow-lg" variant={variant}>
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1">{text}</p>
          <Button
            aria-label="Dismiss"
            className="-my-1 -me-2"
            onClick={onDismiss}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      </Alert>
    </div>
  )
}
