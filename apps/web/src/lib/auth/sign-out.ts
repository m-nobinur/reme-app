import { createServerFn } from "@tanstack/react-start"
import { getRequestUrl } from "@tanstack/react-start/server"
import { signOut } from "@workos/authkit-tanstack-react-start"

/**
 * Signs out and returns to the home page of the deployment the owner is on.
 * WorkOS reads a relative `returnTo` as none and falls back to the
 * environment's default logout URI, which is local dev's, so a preview
 * signed out onto localhost. The absolute address has to be one of the
 * environment's logout URIs (staging lists local dev, staging, production's
 * shared host and `https://*-reme-web.beapp.workers.dev/`).
 */
export const signOutHere = createServerFn({ method: "POST" }).handler(
  async () => {
    await signOut({ data: { returnTo: `${getRequestUrl().origin}/` } })
  }
)
