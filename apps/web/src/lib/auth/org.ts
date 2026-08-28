import { CreateOrgRequest, Org } from "@workspace/contracts"
import { cookiePassword, workos } from "./workos"

/**
 * Signup's second half: the organisation.
 *
 * `apps/web` cannot write `orgs`: it is lint-banned from `@workspace/db`, and
 * §9.2 layer 1 keeps the only database handle in `apps/api`. So this posts to
 * `apps/api`, which creates the WorkOS organization and mirrors it (ADR-029),
 * and then refreshes the session so it carries the `org_id` claim the API
 * resolves the tenant from.
 *
 * Nothing here names an organisation on the way in. The name is a business
 * name typed into the signup form; the WorkOS organization id comes back from
 * WorkOS keyed on the session's own user, and the tenant `org_id` is never
 * mentioned in either direction.
 */

/** The cookie name `apps/api` reads, and the one AuthKit writes. */
const COOKIE = "wos-session"

/**
 * Where `apps/api` answers.
 *
 * A `vars` entry rather than a secret, for the same reason `WORKOS_REDIRECT_URI`
 * is one: it is a public URL. A service binding would save the hop and is not
 * taken here, because it also decides whether `apps/api` should have a public
 * hostname at all, which is a design question and not this story's.
 */
function apiUrl(): string {
  const value = process.env.REME_API_URL
  if (!value) {
    throw new Error(
      "REME_API_URL is not set on this Worker. Local values go in apps/web/.dev.vars; the deployed value is a vars entry in wrangler.jsonc."
    )
  }
  return value
}

/**
 * Creates the org through `apps/api` and returns the session to write.
 *
 * The sealed session is passed in rather than read off the request: it was
 * minted moments ago and the browser has not been handed it yet, so there is
 * no cookie on the incoming request to forward.
 *
 * Safe to run twice, and that is `apps/api`'s doing rather than this file's: a
 * replayed signup adopts the organization the owner is already a member of.
 * The idempotency key is here because R5 asks every mutating endpoint for one,
 * not because it is what makes the retry converge. WorkOS ignores it on
 * organization creation, measured on 2026-08-29 and written up in
 * `apps/api/src/org.ts`. Nothing in the payload identifies the tenant, so a
 * second run cannot land in a different one either way.
 */
export async function createOrgForSession(input: {
  sealedSession: string
  workosUserId: string
  name: string
}): Promise<string> {
  const body = CreateOrgRequest.parse({ name: input.name })
  const response = await fetch(new URL("/org", apiUrl()), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `${COOKIE}=${encodeURIComponent(input.sealedSession)}`,
      "idempotency-key": `org:${input.workosUserId}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(
      `apps/api refused the org write with ${response.status}: ${(await response.text()).slice(0, 200)}`
    )
  }
  // Parsed rather than read loosely, so a drift between the contract and what
  // the API answers fails here instead of two screens later.
  Org.parse(await response.json())

  return refreshInto(input.sealedSession, input.workosUserId)
}

/**
 * Puts the new organisation into the session.
 *
 * A session minted before the organisation existed carries no `org_id` claim,
 * so `apps/api` answers `GET /org` with 403 `org.unresolved` until this runs.
 *
 * The organization id is read back from WorkOS against the session's own user
 * rather than returned by `apps/api`: ADR-029 keeps the vendor id out of the
 * `Org` contract, since it is a join key and not something a screen shows.
 *
 * Measured against staging on 2026-08-29, because two things here are not what
 * the types suggest. Refreshing into an organization the user is not a member
 * of does not return a failure, it throws `OauthException`
 * (`organization_membership_not_found`), which is why the membership is created
 * before this runs and why the caller catches. And a refresh that fails
 * terminally returns no `sealedSession` at all, so writing the result blindly
 * writes `undefined` into the cookie, which `apps/api` then reports as 401
 * `session.absent`, which is also its answer to a request with no cookie. Hence
 * the explicit `authenticated` branch: on anything short of success the session
 * we already hold is returned unchanged, and the person is signed in without an
 * organisation rather than signed out by a bad cookie.
 */
async function refreshInto(
  sealedSession: string,
  workosUserId: string
): Promise<string> {
  const memberships = await workos().userManagement.listOrganizationMemberships(
    { userId: workosUserId, statuses: ["active"], limit: 1 }
  )
  const organizationId = memberships.data[0]?.organizationId
  if (!organizationId) {
    return sealedSession
  }

  const refreshed = await workos()
    .userManagement.loadSealedSession({
      sessionData: sealedSession,
      cookiePassword: cookiePassword(),
    })
    .refresh({ organizationId })
  // `sealedSession` is optional on the success branch too, so it is read
  // rather than asserted: the old session is a worse answer than the new one
  // and a better answer than an empty cookie.
  return (refreshed.authenticated && refreshed.sealedSession) || sealedSession
}
