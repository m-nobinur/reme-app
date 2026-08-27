import type { ErrorEnvelope } from "@workspace/contracts"
import { tenancy } from "@workspace/db"
import { checkTenantPath } from "./health.ts"

/**
 * The Core API (C2). It holds the only database binding in the fleet: §9.2
 * layer 1 puts a server-created tenant context on the only path to a handle,
 * and that path is here.
 *
 * One route so far. The reads that carry an identity wait for the resolver
 * that turns a session into an `org_id`, which is a decision above this file
 * and is not made by taking an id off a request.
 */

/** R4: every failure leaves as the §28.1 envelope, never a raw exception. */
function failure(
  status: number,
  envelope: Omit<ErrorEnvelope, "occurred_at">
): Response {
  const body: ErrorEnvelope = {
    ...envelope,
    occurred_at: new Date().toISOString(),
  }
  return Response.json(body, { status })
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const { pathname } = new URL(request.url)
    if (pathname !== "/health") {
      return failure(404, {
        class: "validation",
        code: "route.not_found",
        message: "No route matches this path.",
        detail: { pathname },
      })
    }

    // A client per request, which is what Hyperdrive is for: it holds the pool
    // and this pays no connection cost. Closed after the response rather than
    // before it, so the body is already on its way out.
    const kit = tenancy(env.HYPERDRIVE.connectionString)
    try {
      const report = await checkTenantPath(kit)
      return Response.json(report, {
        status: report.status === "ok" ? 200 : 503,
      })
    } catch (error) {
      // The code and nothing else. A driver message can carry the connection
      // string it failed on, and this worker logs to an account-wide sink (R9).
      console.error(
        JSON.stringify({
          at: "health",
          code: (error as { code?: string }).code ?? "unknown",
        })
      )
      return failure(503, {
        class: "transient",
        code: "database.unreachable",
        message: "The database did not answer.",
        detail: {},
      })
    } finally {
      ctx.waitUntil(kit.close())
    }
  },
} satisfies ExportedHandler<Env>
