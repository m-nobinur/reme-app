/**
 * Reading a string off a server function's payload.
 *
 * The payload is whatever the network sent, so every field is `unknown` until
 * proved otherwise. Non-strings become empty rather than `String(value)`, which
 * would turn `{}` into "[object Object]" and send it to WorkOS as an email.
 *
 * The cap is not cosmetic. An unbounded password field is a free way to make
 * the server hash megabytes, and an unbounded email is a free way to fill a
 * log line. 512 is longer than any real value here and shorter than anything
 * worth forwarding.
 */
export function text(value: unknown, max = 512): string {
  return typeof value === "string" ? value.trim().slice(0, max) : ""
}

/** Passwords keep their whitespace: a leading space is a legitimate character. */
export function secret(value: unknown, max = 512): string {
  return typeof value === "string" ? value.slice(0, max) : ""
}

/** A one-time code: digits only, at most six of them. */
export function digits(value: unknown, max = 6): string {
  return typeof value === "string" ? value.replace(/\D/g, "").slice(0, max) : ""
}

/** One of a fixed set, or a refusal: never a default the sender did not pick. */
export function oneOf<T extends string>(
  value: unknown,
  options: readonly T[]
): T {
  if (options.includes(value as T)) {
    return value as T
  }
  throw new Error(`Expected one of ${options.join(", ")}.`)
}

/**
 * Keys a request body may not carry, in any spelling.
 *
 * The tenant is resolved from the sealed session (§9.2 layer 1, see
 * ../tenant.ts), so an `org_id` on a payload is either a mistake or an attempt.
 * Both are worth refusing loudly: ignoring the field leaves the next handler
 * free to read it, and answers a probe with a shrug instead of a no.
 *
 * Compared on a normalised key, so `org_id`, `orgId`, `ORG-ID` and
 * `organization_id` are one rule rather than four.
 */
const ORG_KEYS = new Set([
  "org",
  "orgid",
  "organization",
  "organizationid",
  // Both spellings. Ours is British and WorkOS's is American, and a rule that
  // covers one of them is a rule that covers half the payloads we will write.
  "organisation",
  "organisationid",
  "tenant",
  "tenantid",
])

function normalise(key: string): string {
  return key.toLowerCase().replace(/[^a-z]/g, "")
}

/**
 * Nested, because a flat check is defeated by one level of object: a guard that
 * only reads the top of `{ filters: { org_id } }` is a gate that cannot fail.
 * Depth is capped so a deep payload cannot make this the expensive part of a
 * request.
 */
function assertNoOrg(value: unknown, allow: Set<string>, depth: number): void {
  if (depth > 5 || typeof value !== "object" || value === null) {
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertNoOrg(item, allow, depth + 1)
    }
    return
  }
  for (const [key, nested] of Object.entries(value)) {
    const name = normalise(key)
    if (ORG_KEYS.has(name) && !allow.has(name)) {
      throw new Error(
        `A request may not name an organisation: "${key}". The organisation comes from the session.`
      )
    }
    assertNoOrg(nested, allow, depth + 1)
  }
}

/**
 * Every server function payload passes through here, which is why the tenancy
 * check lives here and not in each handler.
 *
 * `allowOrgKeys` has one caller, and one act: choosing which organisation
 * the request is for. `/choose-organisation` picks between the ones WorkOS
 * offered during sign-in, where there is no session yet and the value is
 * checked against the sealed list that was offered. The payload is a claim
 * that is resolved, never a value that is used. Nothing else has a reason to
 * pass it, and passing the field under a name this check does not recognise
 * is the failure the escape hatch exists to make unnecessary.
 */
export function record(
  value: unknown,
  allowOrgKeys: readonly string[] = []
): Record<string, unknown> {
  const data =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {}
  assertNoOrg(data, new Set(allowOrgKeys.map(normalise)), 0)
  return data
}
