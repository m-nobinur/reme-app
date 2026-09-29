import { redirect } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { getRequestUrl } from "@tanstack/react-start/server"
import { getAuth, signOut } from "@workos/authkit-tanstack-react-start"

/**
 * Signs out and returns to the home page of the deployment the owner is on.
 * WorkOS reads a relative `returnTo` as none and falls back to the
 * environment's default logout URI, which is local dev's, so a preview
 * signed out onto localhost. The absolute address has to be one of the
 * environment's logout URIs (staging lists local dev, staging and
 * `https://*-reme-web.beapp.workers.dev/`).
 *
 * With no session, as right after Delete account ends it at WorkOS, the kit
 * redirects to `returnTo` as a route path, and an absolute one became
 * `/sign-out/https:/...`. Nothing is left to end then, so this goes home.
 */
export const signOutHere = createServerFn({ method: "POST" }).handler(
  async () => {
    const { user } = await getAuth()
    if (!user) {
      throw redirect({ to: "/", reloadDocument: true })
    }
    await signOut({ data: { returnTo: `${getRequestUrl().origin}/` } })
  }
)
