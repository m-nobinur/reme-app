import { redirect } from "@tanstack/react-router"
import { createServerFn } from "@tanstack/react-start"
import { getRequestUrl } from "@tanstack/react-start/server"
import {
  getAuth,
  getAuthkit,
  signOut,
} from "@workos/authkit-tanstack-react-start"

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

/**
 * Drops this browser's session cookie and nothing else, for a session the api
 * refuses while WorkOS still holds it. `signOutHere` goes through WorkOS and
 * lands on the home page; this one stays put, so the caller can send the owner
 * to sign in with a return path and the sign-in page finds nobody signed in
 * to bounce back to /app.
 */
export async function endSessionHere(): Promise<void> {
  await (await getAuthkit()).clearSession(new Response())
}
