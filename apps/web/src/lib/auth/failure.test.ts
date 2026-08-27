import { describe, expect, it } from "vitest"
import { toFailure } from "./failure"

/**
 * Every fixture below is a WorkOS response measured against the staging
 * environment on 2026-08-27, trimmed to the fields the mapping reads. They are
 * not invented shapes: the reason this file exists is that four different
 * exception classes carry their reason in four different places, and a mapping
 * written from the documentation got two of them wrong.
 */

const invalidCredentials = {
  name: "GenericServerException",
  status: 400,
  code: "invalid_credentials",
  message: "Invalid credentials for 'owner@example.com'.",
}

const weakPassword = {
  name: "BadRequestException",
  status: 400,
  code: "password_strength_error",
  message: "Password does not meet strength requirements.",
  errors: [
    {
      message:
        "The provided password does not meet the minimum length requirements. Please try a password with 10 or more characters.",
      code: "password_too_short",
    },
    {
      message: "The provided password is not strong enough. ",
      code: "password_too_weak",
    },
  ],
}

const emailTaken = {
  name: "BadRequestException",
  status: 400,
  code: "user_creation_error",
  message: "Could not create user.",
  errors: [
    { code: "email_not_available", message: "This email is not available." },
  ],
}

const badCode = {
  name: "GenericServerException",
  status: 400,
  code: "invalid_one_time_code",
  message: "Invalid one-time code",
}

const deadResetToken = {
  name: "NotFoundException",
  status: 404,
  code: "password_reset_token_not_found",
  message: "Could not locate user with provided token: 'nope'",
}

const magicAuthOff = {
  name: "OauthException",
  status: 400,
  error: "authentication_method_not_allowed",
  errorDescription: "Magic Auth is disabled.",
  message: "Error: authentication_method_not_allowed",
}

describe("toFailure", () => {
  it("never repeats the email back on a failed sign-in", () => {
    const failure = toFailure(invalidCredentials)
    expect(failure.code).toBe("invalid_credentials")
    expect(failure.message).not.toContain("owner@example.com")
    // One message for a wrong password and for no account at all, which is
    // what stops the form answering "does this person bank here".
    expect(failure.field).toBeUndefined()
  })

  it("renders the policy WorkOS enforces rather than one written here", () => {
    const failure = toFailure(weakPassword)
    expect(failure.field).toBe("password")
    expect(failure.message).toContain("10 or more characters")
    expect(failure.message).toContain("not strong enough")
  })

  it("reads a taken email out of the errors array, not the message", () => {
    // The top-level message is "Could not create user.", which tells the person
    // nothing. The reason is one level down.
    const failure = toFailure(emailTaken)
    expect(failure.code).toBe("email_not_available")
    expect(failure.field).toBe("email")
  })

  it("puts a bad one-time code against the code field", () => {
    expect(toFailure(badCode).field).toBe("code")
  })

  it("treats an expired and an already-used reset link the same", () => {
    const failure = toFailure(deadResetToken)
    expect(failure.code).toBe("reset_link_dead")
    expect(failure.message).toMatch(/expired or has already been used/)
  })

  it("reads an OauthException, which carries no code at all", () => {
    const failure = toFailure(magicAuthOff)
    expect(failure.code).toBe("authentication_method_not_allowed")
    expect(failure.message).toMatch(/turned off/)
  })

  it("carries the retry window from a rate limit", () => {
    const failure = toFailure({
      name: "RateLimitExceededException",
      status: 429,
      retryAfter: 45,
    })
    expect(failure.code).toBe("rate_limited")
    expect(failure.retryAfter).toBe(45)
    expect(failure.message).toContain("45")
  })

  it("still says something useful when the rate limit gives no window", () => {
    const failure = toFailure({
      name: "RateLimitExceededException",
      status: 429,
    })
    expect(failure.retryAfter).toBeUndefined()
    expect(failure.message).toMatch(/Wait a minute/)
  })

  it("falls back rather than throwing on anything unrecognised", () => {
    for (const value of [null, undefined, "boom", 42, new Error("network")]) {
      expect(toFailure(value).code).toBe("unavailable")
    }
  })

  it("does not leak a raw exception string into the message", () => {
    const failure = toFailure(new Error("connect ECONNREFUSED 10.0.0.1:443"))
    expect(failure.message).not.toContain("ECONNREFUSED")
  })
})
