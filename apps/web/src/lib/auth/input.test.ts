import { describe, expect, it } from "vitest"
import { digits, oneOf, record, secret, text } from "./input"

describe("reading a server function payload", () => {
  it("turns a non-string into empty rather than into its toString", () => {
    // The failure this pins: String({}) is "[object Object]", which is a
    // perfectly valid string to hand WorkOS as an email address.
    for (const value of [{}, [], 42, null, undefined, true]) {
      expect(text(value)).toBe("")
      expect(secret(value)).toBe("")
      expect(digits(value)).toBe("")
    }
  })

  it("trims a pasted email but not a password", () => {
    expect(text("  owner@example.com  ")).toBe("owner@example.com")
    // A leading space is a legitimate character in a password and trimming it
    // would silently reject a password the person set elsewhere.
    expect(secret("  spaced  ")).toBe("  spaced  ")
  })

  it("bounds every field", () => {
    expect(text("a".repeat(2000)).length).toBe(512)
    expect(secret("a".repeat(2000)).length).toBe(512)
    expect(digits("1".repeat(50))).toBe("111111")
  })

  it("keeps only digits in a one-time code", () => {
    expect(digits("481 502")).toBe("481502")
    expect(digits("48-15-02")).toBe("481502")
    expect(digits("abc")).toBe("")
  })

  it("gives an object for anything that is not one", () => {
    expect(record(null)).toEqual({})
    expect(record("no")).toEqual({})
    expect(record({ a: 1 })).toEqual({ a: 1 })
  })
})

describe("an organisation named by a request body", () => {
  it("is refused in every spelling", () => {
    for (const key of [
      "org_id",
      "orgId",
      "ORG_ID",
      "org-id",
      "organization_id",
      "organizationId",
      "organisation_id",
      "tenant_id",
      "tenantId",
      "org",
      "tenant",
    ]) {
      expect(
        () => record({ [key]: "org_evil", email: "owner@example.com" }),
        key
      ).toThrow(/may not name an organisation/)
    }
  })

  it("is refused when it hides one level down", () => {
    // The version of this check that reads only the top of the payload passes
    // its own test and stops nothing.
    expect(() => record({ filters: { org_id: "org_evil" } })).toThrow(
      /may not name an organisation/
    )
    expect(() => record({ rows: [{ ok: 1 }, { orgId: "org_evil" }] })).toThrow(
      /may not name an organisation/
    )
  })

  it("names the offending key, so the answer is a fix and not a shrug", () => {
    expect(() => record({ org_id: "org_evil" })).toThrow('"org_id"')
  })

  it("is allowed only where the sign-in flow offers the choice", () => {
    expect(record({ organizationId: "org_a" }, ["organizationId"])).toEqual({
      organizationId: "org_a",
    })
    // The exception is that one key and nothing else it could be spelled as.
    expect(() => record({ org_id: "org_a" }, ["organizationId"])).toThrow()
  })

  it("leaves an ordinary payload alone", () => {
    const body = { email: "owner@example.com", page: 2, filters: { q: "ada" } }
    expect(record(body)).toEqual(body)
  })
})

describe("choosing one of a fixed set", () => {
  const DECISIONS = ["approved", "rejected"] as const

  it("passes a listed value through", () => {
    expect(oneOf("approved", DECISIONS)).toBe("approved")
    expect(oneOf("rejected", DECISIONS)).toBe("rejected")
  })

  it("refuses anything else rather than picking a default", () => {
    // A decision the owner did not send must never become one they did.
    for (const value of ["declined", "", "Approved", null, undefined, 1, {}]) {
      expect(() => oneOf(value, DECISIONS)).toThrow()
    }
  })
})
