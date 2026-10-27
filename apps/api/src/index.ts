import {
  CreateOrgRequest,
  idempotencyKey,
  REQUEST_FAILED,
} from "@workspace/contracts"
import { logFailure, resolveOrg, type Tenancy, tenancy } from "@workspace/db"
import {
  type Accounts,
  deleteAccount,
  removeObjects,
  type Takedown,
} from "./account.ts"
import { type AfterTurn, afterTurnBatch } from "./after-turn.ts"
import { bridge, type Owner } from "./changes.ts"
import { stripeWebhook } from "./domain-buy.ts"
import { certificateWebhook } from "./domain-certificate.ts"
import { checkTenantPath } from "./health.ts"
import {
  BodyTooLarge,
  failure,
  invalid,
  keyMissing,
  readBody,
  tooLarge,
} from "./http.ts"
import { receive } from "./inbound-email.ts"
import { limitWrites } from "./limit.ts"
import {
  createOrg,
  type Directory,
  EmailTaken,
  readOrg,
  readStaffDirectory,
} from "./org.ts"
import { OWNER_PATH, ownerRoute } from "./owner.ts"
import {
  bounded,
  readSession,
  type Session,
  WORKOS_TIMEOUT_MS,
  WorkosTimeout,
  workos,
} from "./session.ts"

/**
 * The Core API (C2). It holds the only database binding in the fleet: §9.2
 * layer 1 puts a server-created tenant context on the only path to a handle,
 * and that path is here.
 *
 * The org id is produced in exactly one place, `resolveOrg` below, out of two
 * vendor ids that came from the sealed session. No route reads an organisation
 * from a path, a query or a body, in any spelling, so the rule that `org_id`
 * never comes from client input is a property of this file rather than a check
 * somebody has to remember to write. The exceptions are `/webhooks/stripe`:
 * its org is in metadata that only our own Stripe calls wrote and Stripe
 * signed, and it reaches the domain row only under that org's RLS; and
 * `/webhooks/cloudflare`, whose org is looked up from the hostname the alert
 * names, behind a secret only Cloudflare holds.
 */

/**
 * What the catch-all logs beside the code: the path, and the org once the
 * session has resolved to one. Never the user, their email or any content.
 */
type Where = { at: string; org_id?: string }

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
  kit: Tenancy,
  where: Where
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
  where.org_id = orgId
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
  if (!key) return keyMissing()
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
      bounded(client.organizations.createOrganization(options, requestOptions)),
    listOrganizationMemberships: (options) =>
      bounded(client.userManagement.listOrganizationMemberships(options)),
    createOrganizationMembership: (options) =>
      bounded(client.userManagement.createOrganizationMembership(options)),
  }
  try {
    const org = await createOrg(kit, directory, {
      name: parsed.data.name,
      idempotencyKey: key,
      workosUserId: session.workosUserId,
      email: session.email,
      displayName: session.name,
    })
    return Response.json(org, { status: 201 })
  } catch (error) {
    if (!(error instanceof EmailTaken)) throw error
    return failure(409, {
      class: "validation",
      code: "account.email_taken",
      message: "Another account already uses this email address.",
      detail: {},
    })
  }
}

/**
 * The owner's own account, from the session and nothing else (ADR-035). The
 * key is required by R5 and not what makes a retry safe: `deleteAccount`
 * finishes whatever a first call left undone.
 */
async function removeAccount(
  request: Request,
  env: Env,
  kit: Tenancy,
  session: Session
): Promise<Response> {
  if (!session) return failure(401, UNAUTHENTICATED)
  const key = idempotencyKey(request)
  if (!key) return keyMissing()
  // Anything but the 204 leaves the route failing, before WorkOS is touched.
  const takedown: Takedown = async (orgId) => {
    const result = await bridge(env, { orgId, session }, "/site/takedown", {
      key,
    })
    if (result.status !== 204) {
      throw Object.assign(new Error("the site was not taken down"), {
        code: "site.takedown_failed",
      })
    }
    // After the takedown, so no build is left to write an object back.
    await removeObjects(env.SITES, orgId)
  }
  const client = workos(env)
  const accounts: Accounts = {
    listOrganizationMemberships: (options) =>
      bounded(client.userManagement.listOrganizationMemberships(options)),
    deleteOrganization: (id) =>
      bounded(client.organizations.deleteOrganization(id)),
    deleteUser: (id) => bounded(client.userManagement.deleteUser(id)),
  }
  switch (await deleteAccount(kit, accounts, takedown, session)) {
    case "deleted":
      return new Response(null, { status: 204 })
    case "not_owner":
      return failure(403, {
        class: "permission",
        code: "account.not_owner",
        message: "Only the owner can delete this account.",
        detail: {},
      })
    case "other_members":
      return failure(409, {
        class: "validation",
        code: "account.other_members",
        message: "Remove the other members of this organisation first.",
        detail: {},
      })
    case "unresolved":
      return failure(403, {
        class: "permission",
        code: "org.unresolved",
        message: "This session is not signed in to an organisation we hold.",
        detail: {},
      })
  }
}

async function route(
  request: Request,
  env: Env,
  kit: Tenancy,
  waitUntil: (promise: Promise<unknown>) => void,
  where: Where
): Promise<Response> {
  const { pathname } = new URL(request.url)
  const method = request.method

  if (pathname === "/health" && method === "GET") {
    const report = await checkTenantPath(kit)
    return Response.json(report, {
      status: report.status === "ok" ? 200 : 503,
    })
  }

  // Stripe's, signed by Stripe: no session, no write limit.
  if (pathname === "/webhooks/stripe" && method === "POST") {
    return stripeWebhook(request, env)
  }
  // Cloudflare's certificate alert, with its secret in a header.
  if (pathname === "/webhooks/cloudflare" && method === "POST") {
    return certificateWebhook(request, env, kit, waitUntil)
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

  // Every write counts against the person's minute, signup and the chat
  // turn among them. A request with no session is refused further on.
  if (method !== "GET" && method !== "HEAD" && session) {
    const limited = await limitWrites(env.WRITE_LIMIT, session.workosUserId)
    if (limited) return limited
  }

  if (pathname === "/org" && method === "POST") {
    return signup(request, env, kit, session)
  }

  if (pathname === "/account" && method === "DELETE") {
    return removeAccount(request, env, kit, session)
  }

  if (
    (pathname === "/org" || pathname === "/staff") &&
    (method === "GET" || method === "HEAD")
  ) {
    const resolved = await currentOrg(session, kit, where)
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
    const resolved = await currentOrg(session, kit, where)
    if ("response" in resolved) return resolved.response
    const answered = await ownerRoute(request, env, kit, resolved, waitUntil)
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
    // before it, so the body is already on its way out, and after any work
    // the response left running, such as a chat turn still streaming.
    const kit = tenancy(env.HYPERDRIVE.connectionString)
    const running: Promise<unknown>[] = []
    const where: Where = { at: new URL(request.url).pathname }
    try {
      return await route(
        request,
        env,
        kit,
        (promise) => running.push(promise),
        where
      )
    } catch (error) {
      if (error instanceof BodyTooLarge) return tooLarge()
      logFailure(where, error)
      if (error instanceof WorkosTimeout) {
        return failure(503, {
          class: "transient",
          code: "workos.timeout",
          message: "The sign-in service did not answer in time. Try again.",
          detail: { timeout_ms: WORKOS_TIMEOUT_MS },
        })
      }
      return failure(503, REQUEST_FAILED)
    } finally {
      ctx.waitUntil(Promise.allSettled(running).then(() => kit.close()))
    }
  },
  queue: afterTurnBatch,
  // Owners' emailed replies (ADR-043), routed here by Email Routing.
  async email(message, env, ctx) {
    const kit = tenancy(env.HYPERDRIVE.connectionString)
    try {
      await receive(message, env, kit)
    } finally {
      ctx.waitUntil(kit.close())
    }
  },
} satisfies ExportedHandler<Env, AfterTurn>
