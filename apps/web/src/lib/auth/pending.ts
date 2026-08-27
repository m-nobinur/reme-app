// Aliased on import. It is a server helper for the current request, not a
// React hook, and the name trips the rules-of-hooks lint in a module that has
// no components in it at all.
import { useSession as openSession } from "@tanstack/react-start/server"
import { cookiePassword } from "./workos"

/**
 * The half-finished sign-in.
 *
 * Password sign-in does not always end in a session. WorkOS can answer with
 * "verify your email first", "enrol in MFA first", "answer an MFA challenge" or
 * "choose an organisation", each carrying a `pendingAuthenticationToken` that
 * the follow-up call needs. That token has to survive a redirect to another
 * page, and it must not reach the browser as readable text: it is half of a
 * credential.
 *
 * So it goes in a sealed, HttpOnly, ten-minute cookie. The sealing is TanStack
 * Start's own `useSession`, which is AES-256-CBC with SHA-256 integrity over
 * the same password the WorkOS session cookie uses. Using it rather than
 * writing a signed cookie by hand is the difference between a dependency we
 * already have and cryptography we would own.
 *
 * `userId` matters: it is what the MFA calls enrol and challenge against. An
 * unsigned cookie would let someone swap in another account's id and enrol a
 * factor on it, so integrity here is not decoration.
 */
export type PendingAuth = {
  token: string
  userId: string
  email: string
  /** Set once a factor has been challenged, for the verify step. */
  challengeId?: string
  /** Where to land after the flow finishes. Always an in-app path. */
  returnTo?: string
  /** Offered when WorkOS asks the person to pick an organisation. */
  organizations?: Array<{ id: string; name: string }>
}

const NAME = "reme-auth-flow"

function config() {
  return {
    name: NAME,
    password: cookiePassword(),
    maxAge: 10 * 60,
    // The cookie is the only channel. Left on, the default would also accept
    // the state from an `x-reme-auth-flow-session` request header.
    sessionHeader: false as const,
  }
}

export async function setPending(data: PendingAuth): Promise<void> {
  const session = await openSession<PendingAuth>(config())
  await session.clear()
  await session.update(data)
}

export async function readPending(): Promise<PendingAuth | null> {
  const session = await openSession<PendingAuth>(config())
  const { token, userId, email } = session.data
  if (!(token && userId && email)) {
    return null
  }
  return session.data as PendingAuth
}

export async function updatePending(
  patch: Partial<PendingAuth>
): Promise<void> {
  const session = await openSession<PendingAuth>(config())
  await session.update(patch)
}

export async function clearPending(): Promise<void> {
  const session = await openSession<PendingAuth>(config())
  await session.clear()
}
