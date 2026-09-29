import { env } from "cloudflare:workers"
import { createServerFn } from "@tanstack/react-start"
import { getAuthKitContextOrNull } from "@workos/authkit-tanstack-react-start"
import { forwardedSession } from "@/lib/api/transport"
import { type AuthFailure, toFailure } from "./failure"
import { digits, record, secret, text } from "./input"
import { createOrgForSession } from "./org"
import { clearOrgIntent, readOrgIntent } from "./org-intent"
import { clearPending, readPending, updatePending } from "./pending"
import { type AuthOutcome, authenticate, writeSession } from "./session"
import { throttleSignIn } from "./throttle"
import { sessionOptions, workos } from "./workos"

/**
 * The server half of every page in the sign-in flow.
 *
 * All of it is `createServerFn`, so the WorkOS client, the API key and the
 * cookie password stay on the server side of the boundary and out of the client
 * graph. Nothing here throws at a page: each function returns a result the page
 * renders, because a thrown exception in a sign-in form is an error screen
 * where a sentence belongs.
 */

const NO_PENDING: AuthFailure = {
  code: "no_pending_auth",
  message:
    "This step expired, or it was started in another tab. Sign in again to pick it up.",
}

/** What the flow pages show about the half-finished sign-in they belong to. */
export type PendingSummary = {
  email: string
  organizations: Array<{ id: string; name: string }>
}

export const getPendingAuth = createServerFn({ method: "GET" }).handler(
  async (): Promise<PendingSummary | null> => {
    const pending = await readPending()
    return pending
      ? { email: pending.email, organizations: pending.organizations ?? [] }
      : null
  }
)

// --- password ---------------------------------------------------------------

export const signIn = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const data = record(input)
    return {
      email: text(data.email),
      password: secret(data.password),
      returnTo: data.returnTo,
    }
  })
  .handler(async ({ data }): Promise<AuthOutcome> => {
    // Before the password reaches WorkOS, so a run of guesses costs us nothing
    // and tells the guesser nothing about whether the address exists.
    const limited = await throttleSignIn(env.SIGN_IN_LIMIT, data.email)
    if (limited) {
      return { status: "failed", failure: limited }
    }
    return authenticate(
      () =>
        workos().userManagement.authenticateWithPassword({
          email: data.email,
          password: data.password,
          ...sessionOptions(),
        }),
      { email: data.email, returnTo: data.returnTo }
    )
  })

export const signUp = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const data = record(input)
    return {
      email: text(data.email),
      password: secret(data.password),
      firstName: text(data.firstName, 128),
      lastName: text(data.lastName, 128),
      // The business, not the tenant. `record()` refuses a payload that names
      // an organisation in any spelling, and this is not one of them: it is a
      // display name the API turns into a WorkOS organization it creates
      // itself, so nothing a caller sends here selects a tenant. 120 is the
      // contract's bound.
      businessName: text(data.businessName, 120),
    }
  })
  .handler(async ({ data }): Promise<AuthOutcome> => {
    try {
      await workos().userManagement.createUser({
        email: data.email,
        password: data.password,
        firstName: data.firstName || undefined,
        lastName: data.lastName || undefined,
      })
    } catch (error) {
      return { status: "failed", failure: toFailure(error) }
    }
    // Straight into a sign-in rather than a second form. The environment
    // requires a verified email, so this answers `email_verification_required`
    // and lands the person on /verify-email with the code already sent.
    //
    // `orgName` rides along because the organisation cannot be created until
    // there is a session to create it under, which is usually two pages later.
    // `authenticate` carries it in the flow cookie and creates the org at the
    // moment the session lands (ADR-029).
    return authenticate(
      () =>
        workos().userManagement.authenticateWithPassword({
          email: data.email,
          password: data.password,
          ...sessionOptions(),
        }),
      { email: data.email, orgName: data.businessName }
    )
  })

// --- email verification -----------------------------------------------------

export const verifyEmail = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ code: digits(record(input).code) }))
  .handler(async ({ data }): Promise<AuthOutcome> => {
    const pending = await readPending()
    if (!pending) {
      return { status: "failed", failure: NO_PENDING }
    }
    return authenticate(
      () =>
        workos().userManagement.authenticateWithEmailVerification({
          code: data.code,
          pendingAuthenticationToken: pending.token,
          ...sessionOptions(),
        }),
      { email: pending.email, returnTo: pending.returnTo }
    )
  })

export const resendVerification = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ sent: boolean; failure?: AuthFailure }> => {
    const pending = await readPending()
    if (!pending) {
      return { sent: false, failure: NO_PENDING }
    }
    try {
      await workos().userManagement.sendVerificationEmail({
        userId: pending.userId,
      })
      return { sent: true }
    } catch (error) {
      return { sent: false, failure: toFailure(error) }
    }
  }
)

// --- forgotten password -----------------------------------------------------

export const requestPasswordReset = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ email: text(record(input).email) }))
  .handler(
    async ({ data }): Promise<{ sent: true } | { failure: AuthFailure }> => {
      try {
        await workos().userManagement.createPasswordReset({ email: data.email })
      } catch (error) {
        // Measured: an address with no account answers 404 `entity_not_found`,
        // which is an account-enumeration oracle if it reaches the page. It is
        // swallowed so that both answers look identical from outside. Anything
        // else is a real failure and is reported.
        const code = (error as { code?: string }).code
        if (code !== "entity_not_found") {
          return { failure: toFailure(error) }
        }
      }
      return { sent: true }
    }
  )

export const resetPassword = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const data = record(input)
    return { token: text(data.token, 256), password: secret(data.password) }
  })
  .handler(
    async ({ data }): Promise<{ reset: true } | { failure: AuthFailure }> => {
      if (!data.token) {
        return {
          failure: {
            code: "reset_link_dead",
            message:
              "This link is missing its token. Ask for a new reset email.",
          },
        }
      }
      try {
        await workos().userManagement.resetPassword({
          token: data.token,
          newPassword: data.password,
        })
        return { reset: true }
      } catch (error) {
        const failure = toFailure(error)
        return {
          failure:
            failure.field === "password"
              ? { ...failure, field: "newPassword" }
              : failure,
        }
      }
    }
  )

// --- multi-factor -----------------------------------------------------------

export type MfaEnrolment = {
  /** A `data:image/png;base64,…` QR code, rendered as an image. */
  qrCode: string
  /** The same secret in text, for an authenticator that cannot scan. */
  secret: string
}

export const startMfaEnrolment = createServerFn({ method: "POST" }).handler(
  async (): Promise<MfaEnrolment | { failure: AuthFailure }> => {
    const pending = await readPending()
    if (!pending) {
      return { failure: NO_PENDING }
    }
    try {
      const enrolled = await workos().multiFactorAuth.createUserAuthFactor({
        userId: pending.userId,
        type: "totp",
        totpIssuer: "Reme",
        totpUser: pending.email,
      })
      await updatePending({ challengeId: enrolled.authenticationChallenge.id })
      return {
        qrCode: enrolled.authenticationFactor.totp.qrCode,
        secret: enrolled.authenticationFactor.totp.secret,
      }
    } catch (error) {
      return { failure: toFailure(error) }
    }
  }
)

export const startMfaChallenge = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ challenged: true } | { failure: AuthFailure }> => {
    const pending = await readPending()
    if (!pending) {
      return { failure: NO_PENDING }
    }
    try {
      const factors = await workos().multiFactorAuth.listUserAuthFactors({
        userId: pending.userId,
      })
      const totp = factors.data.find((factor) => factor.type === "totp")
      if (!totp) {
        return {
          failure: {
            code: "no_factor",
            message:
              "There is no authenticator app on this account yet. Set one up to continue.",
          },
        }
      }
      const challenge = await workos().multiFactorAuth.challengeFactor({
        authenticationFactorId: totp.id,
      })
      await updatePending({ challengeId: challenge.id })
      return { challenged: true }
    } catch (error) {
      return { failure: toFailure(error) }
    }
  }
)

export const confirmMfa = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({ code: digits(record(input).code) }))
  .handler(async ({ data }): Promise<AuthOutcome> => {
    const pending = await readPending()
    if (!pending?.challengeId) {
      return { status: "failed", failure: NO_PENDING }
    }
    return authenticate(
      () =>
        workos().userManagement.authenticateWithTotp({
          code: data.code,
          pendingAuthenticationToken: pending.token,
          authenticationChallengeId: pending.challengeId as string,
          ...sessionOptions(),
        }),
      { email: pending.email, returnTo: pending.returnTo }
    )
  })

// --- choosing an organisation ----------------------------------------------

export const chooseOrganization = createServerFn({ method: "POST" })
  .validator((input: unknown) => ({
    // The one payload allowed to name an organisation, and only because there
    // is no session to resolve one from yet. The handler below checks it
    // against the list WorkOS offered, which is sealed in the flow cookie.
    organizationId: text(record(input, ["organizationId"]).organizationId, 64),
  }))
  .handler(async ({ data }): Promise<AuthOutcome> => {
    const pending = await readPending()
    if (!pending) {
      return { status: "failed", failure: NO_PENDING }
    }
    // The id has to be one WorkOS offered. Taking it from the payload alone
    // would let someone name any organisation; WorkOS would refuse, but the
    // refusal would read as a server error rather than a wrong choice.
    const offered = pending.organizations ?? []
    if (!offered.some((org) => org.id === data.organizationId)) {
      return {
        status: "failed",
        failure: {
          code: "organization_not_offered",
          message: "That is not one of the organisations on this account.",
        },
      }
    }
    return authenticate(
      () =>
        workos().userManagement.authenticateWithOrganizationSelection({
          organizationId: data.organizationId,
          pendingAuthenticationToken: pending.token,
          ...sessionOptions(),
        }),
      { email: pending.email, returnTo: pending.returnTo }
    )
  })

// --- an organisation signup could not write --------------------------------

/**
 * The organisation a signup could not write, written now. The /app frame
 * calls this for a signed-in session with no organisation and a business
 * name recorded for the same user. Safe to run again: `apps/api` adopts the
 * organisation the person already belongs to, under the same key. True when
 * the session now carries it, so the page reads again under it; otherwise the
 * name stays recorded for the next visit.
 */
export const retryOrgWrite = createServerFn({ method: "POST" }).handler(
  async (): Promise<boolean> => {
    const intent = await readOrgIntent()
    const auth = getAuthKitContextOrNull()?.auth()
    if (
      !intent ||
      !auth?.user ||
      auth.organizationId ||
      auth.user.id !== intent.userId
    ) {
      return false
    }
    const sealedSession = await forwardedSession()
    if (!sealedSession) return false
    try {
      const next = await createOrgForSession({
        sealedSession,
        workosUserId: intent.userId,
        name: intent.orgName,
      })
      if (next === sealedSession) return false
      await writeSession(next)
      await clearOrgIntent()
      return true
    } catch (error) {
      // The message only, as at signup (R9).
      console.error(
        JSON.stringify({
          at: "signup.org.retry",
          message: error instanceof Error ? error.message : "unknown",
        })
      )
      return false
    }
  }
)

// --- leaving ----------------------------------------------------------------

export const abandonFlow = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ cleared: true }> => {
    await clearPending()
    return { cleared: true }
  }
)
