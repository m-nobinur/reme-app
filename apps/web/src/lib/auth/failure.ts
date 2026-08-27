/**
 * Turning a WorkOS error into something a person can act on.
 *
 * Every branch below was measured against the staging environment rather than
 * read off documentation, and the measured `code` is quoted on each one. The
 * shapes are not uniform: three different exception classes carry a `code`, one
 * carries an `errors` array with the field-level detail, and one carries the
 * OAuth `error`/`error_description` pair instead.
 *
 * Two rules the copy follows. We write the message, not WorkOS, except where
 * WorkOS returns genuine per-field detail we would otherwise be inventing (the
 * password policy). And a message never repeats back what the person typed:
 * `invalid_credentials` arrives as "Invalid credentials for '<email>'.", which
 * would put an address into a page that may be shared or screenshotted.
 */
export type FailureField = "email" | "password" | "code" | "newPassword"

export type AuthFailure = {
  /** Stable identifier for the case, for tests and for logs. */
  code: string
  /** Shown to the person. */
  message: string
  /** Set when the message belongs against one input rather than the form. */
  field?: FailureField
  /** Seconds, from a rate-limit response. */
  retryAfter?: number
}

type Unknownish = Record<string, unknown> | null | undefined

/**
 * A thrown value as a bag of properties. Exported because `session.ts` reads the
 * same fields off the same exceptions, and because a `catch` binding is narrowed
 * to non-nullish by the linter even though it is genuinely `unknown`.
 */
export function asRecord(error: unknown): Record<string, unknown> {
  return (error ?? {}) as Record<string, unknown>
}

function codeOf(error: Unknownish): string | undefined {
  const value = error?.code
  return typeof value === "string" ? value : undefined
}

/** The `errors` array on a BadRequestException, when it has one. */
function detail(error: Unknownish): Array<{ code?: string; message?: string }> {
  const errors = error?.errors
  return Array.isArray(errors) ? errors : []
}

const GENERIC: AuthFailure = {
  code: "unavailable",
  message:
    "We could not reach the sign-in service. Nothing was changed. Try again in a moment.",
}

export function toFailure(error: unknown): AuthFailure {
  const raw = asRecord(error)
  const status = typeof raw.status === "number" ? raw.status : undefined
  const code = codeOf(raw)

  // Measured: RateLimitExceededException, and `retryAfter` may be null.
  if (status === 429 || raw.name === "RateLimitExceededException") {
    const retryAfter =
      typeof raw.retryAfter === "number" ? raw.retryAfter : undefined
    return {
      code: "rate_limited",
      message: retryAfter
        ? `Too many attempts. Try again in ${retryAfter} seconds.`
        : "Too many attempts. Wait a minute and try again.",
      retryAfter,
    }
  }

  switch (code) {
    // Measured: GenericServerException, status 400. Covers both a wrong
    // password and an address with no account, which is deliberate on WorkOS's
    // side and which we keep: one message for both leaks nothing about who has
    // an account here.
    case "invalid_credentials":
      return {
        code: "invalid_credentials",
        message: "That email and password do not match an account.",
      }

    // Measured: BadRequestException, status 400, with an `errors` array whose
    // entries carry the policy detail. This is the one place we render WorkOS's
    // own text: the environment owns the policy (currently 10 characters and
    // strength 3) and restating it here would drift from it.
    case "password_strength_error": {
      const reasons = detail(raw)
        .map((entry) => entry.message?.trim())
        .filter((message): message is string => Boolean(message))
      return {
        code: "password_strength_error",
        field: "password",
        message:
          reasons.length > 0
            ? reasons.join(" ")
            : "That password is not strong enough. Try a longer one.",
      }
    }

    // Measured: BadRequestException, status 400, message "Could not create
    // user.", with the real reason one level down in `errors`.
    case "user_creation_error": {
      const taken = detail(raw).some(
        (entry) => entry.code === "email_not_available"
      )
      return taken
        ? {
            code: "email_not_available",
            field: "email",
            message:
              "There is already an account with that email. Sign in instead, or reset the password.",
          }
        : {
            code: "user_creation_error",
            message:
              "We could not create that account. Check the details and try again.",
          }
    }

    // Measured: GenericServerException, status 400. Raised by magic auth and
    // by email verification for a code that is wrong, expired or already spent.
    // WorkOS does not distinguish the three, so neither do we.
    case "invalid_one_time_code":
      return {
        code: "invalid_one_time_code",
        field: "code",
        message:
          "That code is not right, or it has expired. Ask for a new one and try again.",
      }

    // Measured: NotFoundException, status 404, from resetPassword.
    case "password_reset_token_not_found":
      return {
        code: "reset_link_dead",
        message:
          "This link has expired or has already been used. Ask for a new one.",
      }

    // Measured: NotFoundException, status 404, from createPasswordReset with an
    // address that has no account. Callers that must not confirm whether an
    // account exists swallow this before it reaches here.
    case "entity_not_found":
      return {
        code: "entity_not_found",
        message: "We could not find that account.",
      }

    default:
      break
  }

  // Measured: OauthException, status 400, which carries `error` and
  // `errorDescription` instead of `code`. Magic Auth being disabled on the
  // environment arrives this way.
  if (raw.name === "OauthException") {
    const oauthError = typeof raw.error === "string" ? raw.error : "oauth_error"
    return {
      code: oauthError,
      message:
        oauthError === "authentication_method_not_allowed"
          ? "That way of signing in is turned off for this workspace."
          : "Sign-in was refused. Try again, or use a different method.",
    }
  }

  return GENERIC
}
