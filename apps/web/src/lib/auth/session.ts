import { getAuthkit } from "@workos/authkit-tanstack-react-start"
import type { AuthenticationResponse } from "@workos-inc/node"
import { type AuthFailure, asRecord, toFailure } from "./failure"
import { createOrgForSession } from "./org"
import { recordOrgIntent } from "./org-intent"
import { clearPending, readPending, setPending } from "./pending"
import { safeReturnTo } from "./redirect-target"
import { workos } from "./workos"

/**
 * Everything a sign-in attempt can end as. There is no throw: a route renders
 * one of these three and never sees an exception.
 */
/** Where a signed-in account with no business names one. */
export const NAME_BUSINESS = "/name-your-business"

export type AuthOutcome =
  | { status: "signed-in"; redirectTo: string }
  | { status: "next"; redirectTo: string }
  | { status: "failed"; failure: AuthFailure }

/**
 * The one place a session cookie is written.
 *
 * `sealedSession` comes from `@workos-inc/node`, which seals it (ADR-024), and
 * the cookie is written by the AuthKit kit's own storage (ADR-026), so the
 * name, path, `SameSite`, `Secure` and max-age all come from the kit's
 * configuration rather than from a literal here. `saveSession(undefined, …)`
 * routes the `Set-Cookie` through the middleware's pending-header channel,
 * which is why `authkitMiddleware` has to be registered for any of this to
 * work — the kit throws rather than dropping the cookie silently if it is not.
 */
export async function writeSession(sealedSession: string): Promise<void> {
  const authkit = await getAuthkit()
  await authkit.saveSession(undefined, sealedSession)
}

/** The `code` values WorkOS answers an incomplete authentication with. */
type StepCode =
  | "email_verification_required"
  | "mfa_enrollment"
  | "mfa_challenge"
  | "mfa_verification"
  | "organization_selection_required"

const STEP_PATH: Record<StepCode, string> = {
  email_verification_required: "/verify-email",
  mfa_enrollment: "/mfa-setup",
  mfa_challenge: "/mfa",
  mfa_verification: "/mfa",
  organization_selection_required: "/choose-organisation",
}

function isStepCode(code: unknown): code is StepCode {
  return typeof code === "string" && code in STEP_PATH
}

/**
 * The user id behind an incomplete authentication.
 *
 * Measured: the `email_verification_required` payload carries `email` and
 * `email_verification_id` but no user object, while other codes may carry
 * `user`. So the id is read where it exists and looked up by email where it
 * does not, rather than assumed present.
 */
async function resolveUserId(
  rawData: Record<string, unknown>,
  email: string
): Promise<string | null> {
  const user = rawData.user as { id?: string } | undefined
  if (user?.id) {
    return user.id
  }
  const found = await workos().userManagement.listUsers({ email, limit: 1 })
  return found.data[0]?.id ?? null
}

/**
 * Creates the organisation a signup asked for, and returns the session to
 * write: the refreshed one if it worked, the one we already have if it did not.
 *
 * Not fatal, deliberately. The WorkOS user exists by the time this runs, so
 * refusing the sign-in would leave the person with an account they cannot get
 * into and a signup form that now answers "email already in use". Signed in
 * without an organisation is a state the app already has a shape for, and the
 * write is safe to run again: the business name is recorded, and the /app
 * frame writes it on the person's next visit (`retryOrgWrite`).
 */
async function provisionOrg(
  response: AuthenticationResponse,
  orgName: string | undefined
): Promise<string> {
  const sealedSession = response.sealedSession as string
  // Nothing to create: no signup started this, or the session already resolves
  // to an organisation.
  if (!orgName || response.organizationId) {
    return sealedSession
  }
  let next = sealedSession
  try {
    next = await createOrgForSession({
      sealedSession,
      workosUserId: response.user.id,
      name: orgName,
    })
  } catch (error) {
    // The message and nothing else. This runs a line after a sealed session
    // and a password, and a Worker logs to an account-wide sink (R9).
    console.error(
      JSON.stringify({
        at: "signup.org",
        message: error instanceof Error ? error.message : "unknown",
      })
    )
  }
  // The same session back means the organisation is not in it yet. Kept for
  // the retry; a cookie that cannot be written still costs no one the sign-in.
  if (next === sealedSession) {
    await recordOrgIntent({ userId: response.user.id, orgName }).catch(
      () => undefined
    )
  }
  return next
}

/**
 * Runs one `authenticateWith*` call and turns whatever comes back into an
 * outcome: a session, the next page in the flow, or a message.
 *
 * `nameBusiness` is for a flow that never asks for the business, which is
 * Google: WorkOS makes the account on the first sign-in, so a session that
 * lands with no organisation and no name to create one from goes to
 * /name-your-business before anything else.
 */
export async function authenticate(
  attempt: () => Promise<AuthenticationResponse>,
  options: {
    email: string
    returnTo?: unknown
    orgName?: string
    nameBusiness?: boolean
  }
): Promise<AuthOutcome> {
  const returnTo = safeReturnTo(options.returnTo)
  // Read before the attempt, because the attempt clears it on success and the
  // business name a signup started with is in there.
  const pending = await readPending()
  try {
    const response = await attempt()
    if (!response.sealedSession) {
      // Only reachable if `sessionOptions()` was left off the call, which is a
      // programming error rather than a state a person can be in.
      throw new Error("WorkOS returned no sealed session.")
    }
    const orgName = options.orgName ?? pending?.orgName
    await writeSession(await provisionOrg(response, orgName))
    await clearPending()
    if (options.nameBusiness && !response.organizationId && !orgName) {
      return {
        status: "signed-in",
        redirectTo: `${NAME_BUSINESS}?returnTo=${encodeURIComponent(returnTo)}`,
      }
    }
    return { status: "signed-in", redirectTo: returnTo }
  } catch (error) {
    const raw = asRecord(error)
    const code = raw.code

    if (isStepCode(code)) {
      const rawData = (raw.rawData ?? {}) as Record<string, unknown>
      const token = raw.pendingAuthenticationToken
      const email =
        typeof rawData.email === "string" ? rawData.email : options.email
      const userId = await resolveUserId(rawData, email)

      if (typeof token === "string" && userId) {
        const organizations = Array.isArray(rawData.organizations)
          ? (rawData.organizations as Array<{ id: string; name: string }>)
          : undefined
        await setPending({
          token,
          userId,
          email,
          returnTo,
          organizations,
          orgName: options.orgName ?? pending?.orgName,
        })
        return { status: "next", redirectTo: STEP_PATH[code] }
      }
      // A step we cannot carry forward, because the token or the user is
      // missing. Reported rather than retried into a loop.
      return {
        status: "failed",
        failure: {
          code: "incomplete_step",
          message:
            "Sign-in needs another step that we could not start. Try signing in again.",
        },
      }
    }

    if (code === "sso_required" || raw.error === "sso_required") {
      return {
        status: "failed",
        failure: {
          code: "sso_required",
          message:
            "This account signs in through your company's identity provider. Use that instead of a password.",
        },
      }
    }

    if (code === "radar_email_challenge" || code === "radar_sms_challenge") {
      // Radar is not enabled on this environment, so this is unreachable today
      // and is here so that turning Radar on produces a message rather than a
      // raw exception.
      return {
        status: "failed",
        failure: {
          code: "radar_challenge",
          message:
            "This sign-in needs an extra check we do not support yet. Try again later.",
        },
      }
    }

    return { status: "failed", failure: toFailure(error) }
  }
}
