import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers"
import { NonRetryableError } from "cloudflare:workflows"
import { Sandbox } from "@cloudflare/sandbox"
import { type Tenancy, tenancy } from "@workspace/db"
import {
  NPM_REGISTRY_HOST,
  PoolExhaustedError,
  provision,
  SLEEP_AFTER,
} from "./sandbox.ts"
import { advance, appendEvent, claim, TransitionError } from "./state.ts"
import { stubDeveloper, stubGates } from "./stub.ts"

// The outbound proxy the platform routes container egress through; the SDK
// needs it exported from the Worker for its own internal hosts.
export { ContainerProxy } from "@cloudflare/sandbox"

/**
 * The container behind every assignment (ADR-031): egress denied by default
 * with the registry as the one exception, asleep after a short idle, and
 * holding nothing the Worker holds. The image is infra/sandbox/Dockerfile;
 * the instance type and the pool size are in wrangler.jsonc.
 */
export class RemeSandbox extends Sandbox<Env> {
  override enableInternet = false
  override allowedHosts = [NPM_REGISTRY_HOST]
  // Without this, port 443 is closed outright and the allowlist never sees
  // an HTTPS request: the platform intercepts only what it is told to. With
  // it, HTTPS is terminated at the outbound proxy, the container trusts the
  // proxy's ephemeral CA, and the allowlist decides. Measured on staging
  // 2026-09-15: the registry timed out at the TCP level until this was set.
  override interceptHttps = true
  override sleepAfter = SLEEP_AFTER
}

// The platform injects the proxy's CA into the container only when an
// outbound handler exists, and the control server refuses to start under
// HTTPS interception without that CA (measured 2026-09-15: "Certificate not
// found, refusing to start"). This handler is the allowlist's pass-through:
// the proxy has already refused every host not in `allowedHosts` by the time
// it runs. Assigned rather than declared as a static field, because a field
// would shadow the base class's setter instead of registering the handler.
RemeSandbox.outbound = (request: Request) => fetch(request)

/** R8: ids only. Everything else is read from the row inside a step. */
export type AssignmentParams = { assignment_id: string; org_id: string }

/** How long a queued assignment waits for the site lock: 20 × 30 s. */
const CLAIM_ATTEMPTS = 20

/**
 * One instance per assignment, one `step.do` per §8.4 state. A step that
 * throws a `transient` refusal is retried by Workflows; a `validation` or
 * `resource` one is final, because the row moved under us (cancelled from the
 * console) and no retry makes the edge legal.
 */
export class AssignmentWorkflow extends WorkflowEntrypoint<
  Env,
  AssignmentParams
> {
  async run(event: WorkflowEvent<AssignmentParams>, step: WorkflowStep) {
    const ids = {
      orgId: event.payload.org_id,
      assignmentId: event.payload.assignment_id,
    }
    const run = async <T>(fn: (kit: Tenancy) => Promise<T>): Promise<T> => {
      const kit = tenancy(this.env.HYPERDRIVE.connectionString)
      try {
        return await fn(kit)
      } catch (error) {
        if (
          error instanceof TransitionError &&
          error.errorClass !== "transient"
        ) {
          throw new NonRetryableError(error.code)
        }
        throw error
      } finally {
        await kit.close()
      }
    }

    let claimed = false
    for (let attempt = 1; attempt <= CLAIM_ATTEMPTS && !claimed; attempt++) {
      claimed = await step.do(`claim ${attempt}`, () =>
        run((kit) => claim(kit, ids, attempt === 1))
      )
      if (!claimed) await step.sleep(`site busy ${attempt}`, "30 seconds")
    }
    if (!claimed) return { outcome: "queued" }

    // The container, after the site lock and not before: the lock is one
    // org's, the pool is everyone's, so the scarce thing is taken last. The
    // same loop as the claim, with one `pool.exhausted` event on the first
    // refusal only. Only a full pool waits; any other error takes the step's
    // retry policy, so a bad image fails rather than retrying for ten minutes.
    let ready = false
    for (let attempt = 1; attempt <= CLAIM_ATTEMPTS && !ready; attempt++) {
      ready = await step.do(`sandbox ${attempt}`, async () => {
        try {
          const { cold_start_ms } = await provision(this.env, ids.assignmentId)
          await run((kit) =>
            appendAudit(kit, ids, "sandbox.provisioned", { cold_start_ms })
          )
          return true
        } catch (error) {
          if (!(error instanceof PoolExhaustedError)) throw error
          if (attempt === 1) {
            await run((kit) =>
              appendAudit(kit, ids, "pool.exhausted", { reason: error.reason })
            )
          }
          return false
        }
      })
      if (!ready) await step.sleep(`pool full ${attempt}`, "30 seconds")
    }
    if (!ready) return { outcome: "pool_exhausted" }

    await step.do("planning", () => run((kit) => advance(kit, ids, "planning")))
    await step.do("implementing", () =>
      run((kit) => advance(kit, ids, "implementing"))
    )
    await step.do("developer", () => run((kit) => stubDeveloper(kit, ids)))
    await step.do("validating", () => run((kit) => stubGates(kit, ids)))
    return { outcome: "preview_ready" }
  }
}

/** One audit row for a step that moves no state. */
function appendAudit(
  kit: Tenancy,
  ids: { orgId: string; assignmentId: string },
  type: string,
  payload: Record<string, unknown>
) {
  return kit.withOrg({ orgId: ids.orgId }, (db) =>
    appendEvent(db, {
      orgId: ids.orgId,
      assignmentId: ids.assignmentId,
      staffId: null,
      type,
      payload,
    })
  )
}
