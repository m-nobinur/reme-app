import { redirect } from "@tanstack/react-router"
import {
  getAuth,
  type NoUserInfo,
  type UserInfo,
} from "@workos/authkit-tanstack-react-start"
import { safeReturnTo } from "./auth/redirect-target"

/**
 * Who the request is for, resolved on the server.
 *
 * `orgId` is the whole point of this file. It comes from the `org_id` claim on
 * the access token inside the sealed session cookie, which the AuthKit session
 * layer verifies against the WorkOS JWKS before any of it is readable
 * (`jwtVerify` in `validateAndRefresh`, and an unseal that throws rather than
 * returning `{}` — ADR-024). So it is a value WorkOS signed, not a value a
 * browser sent. No request payload, query string or header is consulted, here
 * or anywhere else: `record()` in ./auth/input.ts refuses a body that names an
 * organisation at all.
 *
 * `null` until the session carries an organisation, which is a signup whose
 * organisation is not written yet: the app says so rather than inventing one.
 */
export type Owner = {
  userId: string
  email: string
  /** Whatever the person gave WorkOS, empty if they gave neither name. */
  name: string
  orgId: string | null
  role: string | null
  sessionId: string
}

/**
 * The session as loader data.
 *
 * Split from `requireOwner` so it can be tested without a request: everything
 * worth asserting about tenant resolution is in this mapping. It drops the
 * access token deliberately — this value is serialised into the page, and the
 * token is a bearer credential.
 */
export function ownerFrom(auth: UserInfo | NoUserInfo): Owner | null {
  if (!auth.user) {
    return null
  }
  const { user, sessionId, organizationId, role } = auth
  return {
    userId: user.id,
    email: user.email,
    name: [user.firstName, user.lastName].filter(Boolean).join(" "),
    orgId: organizationId ?? null,
    role: role ?? null,
    sessionId,
  }
}

/**
 * The guard every authenticated route runs.
 *
 * Called from a layout `loader` rather than `beforeLoad`: `beforeLoad` also
 * runs in the browser during hydration, where the sealed session is not
 * readable and this throws. `getAuth` is a server function, so on a client-side
 * navigation it is an RPC to the server and the answer still comes from the
 * cookie rather than from anything the page is holding.
 *
 * `returnTo` is the path the person asked for, sent through the same allowlist
 * the sign-in page validates it with, so a crafted link cannot turn the guard
 * into an open redirect.
 */
export async function requireOwner(returnTo: string): Promise<Owner> {
  const owner = ownerFrom(await getAuth())
  if (!owner) {
    throw redirect({
      to: "/sign-in",
      search: { returnTo: safeReturnTo(returnTo) },
    })
  }
  return owner
}
