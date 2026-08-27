import { getAuthkit } from "@workos/authkit-tanstack-react-start"
import type { AuthenticationResponse } from "@workos-inc/node"
import { type AuthFailure, asRecord, toFailure } from "./failure"
import { clearPending, setPending } from "./pending"
import { safeReturnTo } from "./redirect-target"
import { workos } from "./workos"

/**
 * Everything a sign-in attempt can end as. There is no throw: a route renders
 * one of these three and never sees an exception.
 */
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
async function writeSession(sealedSession: string): Promise<void> {
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
 * Runs one `authenticateWith*` call and turns whatever comes back into an
 * outcome: a session, the next page in the flow, or a message.
 */
export async function authenticate(
  attempt: () => Promise<AuthenticationResponse>,
  options: { email: string; returnTo?: unknown }
): Promise<AuthOutcome> {
  const returnTo = safeReturnTo(options.returnTo)
  try {
    const response = await attempt()
    if (!response.sealedSession) {
      // Only reachable if `sessionOptions()` was left off the call, which is a
      // programming error rather than a state a person can be in.
      throw new Error("WorkOS returned no sealed session.")
    }
    await writeSession(response.sealedSession)
    await clearPending()
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
        await setPending({ token, userId, email, returnTo, organizations })
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
