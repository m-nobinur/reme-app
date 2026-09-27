import { CreateOrgRequest } from "@workspace/contracts"
import { failureCode, resolveOrg, type Tenancy, tenancy } from "@workspace/db"
import type { Owner } from "./changes.ts"
import { checkTenantPath } from "./health.ts"
import {
  BodyTooLarge,
  failure,
  idempotencyKey,
  invalid,
  readBody,
  tooLarge,
} from "./http.ts"
import {
  createOrg,
  type Directory,
  readOrg,
  readStaffDirectory,
} from "./org.ts"
import { OWNER_PATH, ownerRoute } from "./owner.ts"
import { readSession, type Session, workos } from "./session.ts"

/**
 * The Core API (C2). It holds the only database binding in the fleet: §9.2
 * layer 1 puts a server-created tenant context on the only path to a handle,
 * and that path is here.
 *
 * The org id is produced in exactly one place, `resolveOrg` below, out of two
 * vendor ids that came from the sealed session. No route reads an organisation
 * from a path, a query or a body, in any spelling, so the rule that `org_id`
 * never comes from client input is a property of this file rather than a check
 * somebody has to remember to write.
 */

const UNAUTHENTICATED = {
  class: "permission",
  code: "session.absent",
  message: "This request carries no session we can read.",
  detail: {},
} as const

/**
 * The org the session is for, or a response saying why there is not one.
 *
 * "Signed in with no organisation selected" and "signed in to an organisation
 * we do not mirror" are the same answer on purpose. A caller able to tell them
 * apart learns which organizations exist, and neither is something the app can
 * act on differently: both mean sign in again, or create the org.
 */
async function currentOrg(
  session: Session,
  kit: Tenancy
): Promise<Owner | { response: Response }> {
  if (!session) return { response: failure(401, UNAUTHENTICATED) }
  const orgId = session.workosOrganizationId
    ? await resolveOrg(kit, {
        workosUserId: session.workosUserId,
        workosOrganizationId: session.workosOrganizationId,
      })
    : null
  if (!orgId) {
    return {
      response: failure(403, {
        class: "permission",
        code: "org.unresolved",
        message: "This session is not signed in to an organisation we hold.",
        detail: {},
      }),
    }
  }
  return { orgId, session }
}

/**
 * R5. The key is required and forwarded to WorkOS, and it is not what makes
 * this endpoint safe to run twice: `POST /organizations` ignores it, measured
 * and written up in `org.ts`. The replay is the owner's own membership, and our
 * write is idempotent against it through `orgs_workos_organization_key`, so no
 * keyed-results table is needed for this endpoint. The one that mutates rows a
 * tenant can see will need one.
 */
async function signup(
  request: Request,
  env: Env,
  kit: Tenancy,
  session: Session
): Promise<Response> {
  if (!session) return failure(401, UNAUTHENTICATED)
  const key = idempotencyKey(request)
  if (!key) {
    return failure(400, {
      class: "validation",
      code: "idempotency_key.missing",
      message: "This request needs an Idempotency-Key header.",
      detail: {},
    })
  }
  // Caught rather than left to the handler, which would answer a body that is
  // not JSON with a 503 and tell the caller to retry something that will never
  // work.
  const parsed = CreateOrgRequest.safeParse(await readBody(request))
  if (!parsed.success) return invalid(parsed.error.issues)
  // The two halves of the SDK the writer needs. Organizations live on
  // `organizations` and memberships on `userManagement`, and `createOrg` takes
  // one object so it can be handed a stand-in.
  const client = workos(env)
  const directory: Directory = {
    createOrganization: (options, requestOptions) =>
      client.organizations.createOrganization(options, requestOptions),
    listOrganizationMemberships: (options) =>
      client.userManagement.listOrganizationMemberships(options),
    createOrganizationMembership: (options) =>
      client.userManagement.createOrganizationMembership(options),
  }
  const org = await createOrg(kit, directory, {
    name: parsed.data.name,
    idempotencyKey: key,
    workosUserId: session.workosUserId,
    email: session.email,
    displayName: session.name,
  })
  return Response.json(org, { status: 201 })
}

async function route(
  request: Request,
  env: Env,
  kit: Tenancy
): Promise<Response> {
  const { pathname } = new URL(request.url)
  const method = request.method

  if (pathname === "/health" && method === "GET") {
    const report = await checkTenantPath(kit)
    return Response.json(report, {
      status: report.status === "ok" ? 200 : 503,
    })
  }

  const session = await readSession(request, env)
  // An admin signed in as someone can look, never act: anything but a read
  // is refused, and a decision above all is the owner's own (§7.3).
  if (method !== "GET" && method !== "HEAD" && session?.impersonated) {
    const decision = pathname.startsWith("/approvals/")
    return failure(403, {
      class: "permission",
      code: decision ? "approval.impersonated" : "owner.impersonated",
      message: decision
        ? "An impersonated session cannot approve or reject."
        : "An impersonated session can read, not change anything.",
      detail: {},
    })
  }

  if (pathname === "/org" && method === "POST") {
    return signup(request, env, kit, session)
  }

  if (
    (pathname === "/org" || pathname === "/staff") &&
    (method === "GET" || method === "HEAD")
  ) {
    const resolved = await currentOrg(session, kit)
    if ("response" in resolved) return resolved.response
    if (pathname === "/staff") {
      return Response.json(await readStaffDirectory(kit, resolved.orgId))
    }
    const org = await readOrg(kit, resolved.orgId)
    // Unreachable through the resolver, which only answers with an org that
    // exists, and answered rather than thrown so a deleted org is a 404.
    return org
      ? Response.json(org)
      : failure(404, {
          class: "resource",
          code: "org.not_found",
          message: "That organisation no longer exists.",
          detail: {},
        })
  }

  if (OWNER_PATH.test(pathname)) {
    const resolved = await currentOrg(session, kit)
    if ("response" in resolved) return resolved.response
    const answered = await ownerRoute(request, env, kit, resolved)
    if (answered) return answered
  }

  return failure(404, {
    class: "validation",
    code: "route.not_found",
    message: "No route matches this path.",
    detail: { pathname },
  })
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // A client per request, which is what Hyperdrive is for: it holds the pool
    // and this pays no connection cost. Closed after the response rather than
    // before it, so the body is already on its way out.
    const kit = tenancy(env.HYPERDRIVE.connectionString)
    try {
      return await route(request, env, kit)
    } catch (error) {
      if (error instanceof BodyTooLarge) return tooLarge()
      // The code and nothing else. A driver message can carry the connection
      // string it failed on, and this worker logs to an account-wide sink (R9).
      console.error(
        JSON.stringify({
          at: new URL(request.url).pathname,
          code: failureCode(error),
        })
      )
      return failure(503, {
        class: "transient",
        code: "request.failed",
        message: "The request could not be completed.",
        detail: {},
      })
    } finally {
      ctx.waitUntil(kit.close())
    }
  },
} satisfies ExportedHandler<Env>
