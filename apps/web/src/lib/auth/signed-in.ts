import { redirect } from "@tanstack/react-router"
import { getAuth } from "@workos/authkit-tanstack-react-start"

/** From the session cookie on the server, so a page can decide before it draws. */
export async function signedIn(): Promise<boolean> {
  return Boolean((await getAuth()).user)
}

/**
 * The loader of every page that only makes sense signed out. /app sends an
 * owner with no business on to naming one, so this needs no second rule. In a
 * loader rather than `beforeLoad` for the reason `requireOwner` gives.
 */
export async function leaveIfSignedIn(): Promise<void> {
  if (await signedIn()) {
    throw redirect({ to: "/app" })
  }
}
