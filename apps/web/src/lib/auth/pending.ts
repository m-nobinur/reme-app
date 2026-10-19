import { clearSealed, readSealed, writeSealed } from "./sealed-cookie"
import type { StepCode } from "./session"

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
 * So it goes in a sealed, HttpOnly, ten-minute cookie (`./sealed-cookie`),
 * sealed by the AuthKit kit over the same password the session cookie uses.
 * Using it rather than writing a signed cookie by hand is the difference
 * between a dependency we already have and cryptography we would own.
 *
 * `userId` matters: it is what the MFA calls enrol and challenge against. An
 * unsigned cookie would let someone swap in another account's id and enrol a
 * factor on it, so integrity here is not decoration.
 */
type PendingAuth = {
  /**
   * The step WorkOS asked for. Each follow-up call checks it, so a challenge
   * step cannot be used to enrol a new factor.
   */
  step: StepCode
  token: string
  userId: string
  email: string
  /** Set once a factor has been challenged, for the verify step. */
  challengeId?: string
  /** Where to land after the flow finishes. Always an in-app path. */
  returnTo?: string
  /** Offered when WorkOS asks the person to pick an organisation. */
  organizations?: Array<{ id: string; name: string }>
  /**
   * The business name typed on the signup form, carried until there is a
   * session to create the organisation under. Signup rarely ends in a session
   * on the first call: the environment requires a verified email, so the name
   * has to survive the hop to /verify-email or it is gone by the time anything
   * can act on it.
   */
  orgName?: string
}

const NAME = "reme-auth-flow"
const LIFETIME_MS = 10 * 60 * 1000

export async function setPending(data: PendingAuth): Promise<void> {
  await writeSealed(NAME, data, Date.now() + LIFETIME_MS)
}

export async function readPending(): Promise<PendingAuth | null> {
  const sealed = await readSealed<PendingAuth>(NAME)
  if (!(sealed?.token && sealed.userId && sealed.email)) {
    return null
  }
  const { expiresAt: _, ...data } = sealed
  return data
}

/** A patch to a flow that has expired or never started writes nothing. */
export async function updatePending(
  patch: Partial<PendingAuth>
): Promise<void> {
  const sealed = await readSealed<PendingAuth>(NAME)
  if (sealed) {
    await writeSealed(NAME, { ...sealed, ...patch }, sealed.expiresAt)
  }
}

export async function clearPending(): Promise<void> {
  clearSealed(NAME)
}
