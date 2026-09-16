import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers"
import { NonRetryableError } from "cloudflare:workflows"
import { Sandbox } from "@cloudflare/sandbox"
import {
  assignments,
  eq,
  facts,
  type Tenancy,
  tenancy,
  toFactRecord,
} from "@workspace/db"
import { AgentInstanceExistsError, init } from "@workspace/facade"
import { Developer } from "./agents/developer.ts"
import {
  type Brief,
  creationChoices,
  issueSpec,
  takeSnapshot,
} from "./brief.ts"
import {
  activate,
  PROBE_MINUTES,
  type PublishParams,
  probeHost,
  readTarget,
  redriveQueued,
  verifyArtifact,
  writePointer,
} from "./publish.ts"
import {
  NPM_REGISTRY_HOST,
  PoolExhaustedError,
  provision,
  SLEEP_AFTER,
  sandboxFor,
} from "./sandbox.ts"
import {
  advance,
  appendEvent,
  claim,
  parkForBudget,
  TransitionError,
} from "./state.ts"
import { assignmentFacts, validateRevision } from "./validate.ts"

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

/** What the Developer's tools send the Workflow: a kind and ids, never a body (R8). */
type DeveloperEvent =
  | { kind: "information"; request_id: string }
  | { kind: "completion"; report_id: string; revision_id: string }
  | { kind: "budget"; cap_usd: number; spent_usd: number }
  | { kind: "interrupted"; reason: string }

/** What the console's `/answer` sends: the request it answers and the fact it wrote. */
type AnswerEvent = { request_id: string; fact_id: string }

/** How long a queued assignment waits for the site lock: 20 × 30 s. */
const CLAIM_ATTEMPTS = 20

/** How many times an interrupted Developer run is resumed before the build fails and releases the site lock. */
const RESUMES = 2

/** Information round trips per assignment before the Workflow stops waiting. */
const ROUNDS = 20

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
      const result = await step.do(`claim ${attempt}`, () =>
        run((kit) => claim(kit, ids, attempt === 1))
      )
      claimed = result.claimed
      const superseded = result.superseded
      if (superseded) {
        // §13 rule 3: a cancelled assignment's container does not outlive it.
        await step.do(`destroy ${superseded}`, async () => {
          await sandboxFor(this.env, superseded).destroy()
          return { destroyed: superseded }
        })
      }
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

    // The brief and the admission in one step, create-only, so a retried
    // step cannot admit the Developer twice: the second attempt finds the
    // instance and returns. The spec and the snapshot are bodies, so they
    // travel inside the step and never cross its boundary (R8).
    await step.do("developer", async () => {
      const brief = await run((kit) =>
        kit.withOrg({ orgId: ids.orgId }, async (db) => {
          const [row] = await db
            .select()
            .from(assignments)
            .where(eq(assignments.id, ids.assignmentId))
          if (!row) throw new NonRetryableError("assignment.not_found")
          const { withhold, model } = await creationChoices(db, ids)
          const snapshot = await takeSnapshot(db, ids, withhold)
          const spec = await issueSpec(db, this.env, row, model)
          const built: Brief = {
            spec,
            snapshot,
            goal: row.goal,
            acceptance_criteria: row.acceptanceCriteria,
            restore_key: null,
          }
          return built
        })
      )
      try {
        const receipt = await init(Developer, {
          id: ids.assignmentId,
          uid: null,
        }).dispatch({
          message: `Build the site from the canonical facts. ${brief.goal}`,
          initialData: brief,
        })
        return { submission_id: receipt.submissionId }
      } catch (error) {
        if (error instanceof AgentInstanceExistsError) {
          return { submission_id: null }
        }
        throw error
      }
    })

    // The nanoclaw pair (§8.3): the tools wake this Workflow with an id, the
    // Workflow answers the Developer with a new submission.
    // A build that cannot continue ends in `failed` and destroys its sandbox,
    // which releases the site lock (§13): a provider that keeps failing or a
    // Developer that never reports must not hold the site for good.
    const fail = async (name: string, reason: string) => {
      await step.do(`fail ${name}`, () =>
        run((kit) => advance(kit, ids, "failed", { reason }))
      )
      await step.do("destroy sandbox", async () => {
        await sandboxFor(this.env, ids.assignmentId).destroy()
        return { destroyed: ids.assignmentId }
      })
      return { outcome: "failed" as const }
    }
    let resumes = 0
    for (let round = 1; round <= ROUNDS; round++) {
      let woke: { payload: DeveloperEvent }
      try {
        woke = await step.waitForEvent<DeveloperEvent>(`developer ${round}`, {
          type: "developer",
          timeout: "2 hours",
        })
      } catch {
        return fail(`timed out ${round}`, "developer.timed_out")
      }
      const payload = woke.payload
      if (payload.kind === "interrupted") {
        if (resumes >= RESUMES) {
          return fail(`interrupted ${round}`, "provider.unavailable")
        }
        resumes++
        await step.sleep(`resume wait ${round}`, "30 seconds")
        await step.do(`resume run ${round}`, async () => {
          await init(Developer, { id: ids.assignmentId }).dispatch({
            message: {
              kind: "signal",
              type: "run.interrupted",
              body: JSON.stringify({ reason: payload.reason }),
              attributes: { attempt: String(resumes) },
            },
          })
          return { resumed: resumes }
        })
        continue
      }
      if (payload.kind === "completion") {
        await step.do(`validating ${round}`, () =>
          run((kit) =>
            advance(kit, ids, "validating", {
              payload: {
                report_id: payload.report_id,
                revision_id: payload.revision_id,
              },
            })
          )
        )
        const verdict = await step.do(`gates ${round}`, () =>
          run((kit) =>
            validateRevision(kit, this.env.SITES, ids, {
              report_id: payload.report_id,
              revision_id: payload.revision_id,
            })
          )
        )
        if (verdict.outcome === "repairing") {
          // The failed rows go back to the same conversation, the way an
          // answer does; the Developer fixes them and reports again.
          await step.do(`repair ${round}`, async () => {
            await init(Developer, { id: ids.assignmentId }).dispatch({
              message: {
                kind: "signal",
                type: "validation.failed",
                body: JSON.stringify({
                  report_id: verdict.report_id,
                  failed: verdict.failed,
                }),
                attributes: { report_id: verdict.report_id },
              },
            })
            return { report_id: verdict.report_id }
          })
          continue
        }
        // ADR-032: the sandbox ends with the build, not at publish.
        await step.do("destroy sandbox", async () => {
          await sandboxFor(this.env, ids.assignmentId).destroy()
          return { destroyed: ids.assignmentId }
        })
        return { outcome: verdict.outcome }
      }
      if (payload.kind === "budget") {
        await step.do(`park ${round}`, () =>
          run((kit) =>
            parkForBudget(kit, ids, {
              cap_usd: payload.cap_usd,
              spent_usd: payload.spent_usd,
            })
          )
        )
        return { outcome: "blocked_on_approval" }
      }
      await step.do(`blocked ${round}`, () =>
        run((kit) =>
          advance(kit, ids, "blocked_on_information", {
            payload: { request_id: payload.request_id },
          })
        )
      )
      const answer = await step.waitForEvent<AnswerEvent>(`answer ${round}`, {
        type: "answer",
        timeout: "7 days",
      })
      await step.do(`resume ${round}`, async () => {
        const fact = await run((kit) =>
          kit.withOrg({ orgId: ids.orgId }, async (db) => {
            const [row] = await db
              .select()
              .from(facts)
              .where(eq(facts.id, answer.payload.fact_id))
            if (!row) throw new NonRetryableError("fact.not_found")
            return toFactRecord(row)
          })
        )
        await run((kit) =>
          advance(kit, ids, "implementing", {
            payload: {
              request_id: answer.payload.request_id,
              fact_id: answer.payload.fact_id,
            },
          })
        )
        // The Developer never sees "the owner said"; it sees a fact record.
        await init(Developer, { id: ids.assignmentId }).dispatch({
          message: {
            kind: "signal",
            type: "information.answered",
            body: JSON.stringify({
              request_id: answer.payload.request_id,
              fact,
            }),
            attributes: { field: fact.key },
          },
        })
        return { fact_id: fact.fact_id }
      })
    }
    return { outcome: "rounds_exhausted" }
  }
}

/** One audit row for a step that moves no state. */
function appendAudit(
  kit: Tenancy,
  ids: { orgId: string; assignmentId: string | null },
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

/**
 * The publisher (ADR-032): one instance per approval, keyed by the approval
 * id so a second create is refused, or per rollback request, keyed by its
 * idempotency key. Every step body is in publish.ts; this is the order.
 */
export class PublishWorkflow extends WorkflowEntrypoint<Env, PublishParams> {
  async run(event: WorkflowEvent<PublishParams>, step: WorkflowStep) {
    const params = event.payload
    const orgId = params.org_id
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
    const rollback = "rollback" in params

    const target = await step.do("read target", () =>
      run((kit) =>
        kit.withOrg({ orgId }, (db) => readTarget(db, this.env, params))
      )
    )

    const artifact = await step.do("verify artifact", () =>
      verifyArtifact(this.env.SITES, target.site_id, target.revision_id)
    )
    if (!artifact.ok) {
      await step.do("refuse", () =>
        run((kit) =>
          appendAudit(
            kit,
            { orgId, assignmentId: target.assignment_id },
            "publish.refused",
            { revision_id: target.revision_id, reason: artifact.message }
          )
        )
      )
      return { outcome: "refused", reason: artifact.message }
    }

    const deployment = await step.do("activate", () =>
      run((kit) =>
        kit.withOrg({ orgId }, async (db) => {
          const row = await activate(db, orgId, {
            siteId: target.site_id,
            revisionId: target.revision_id,
            kind: rollback ? "rollback" : "publish",
            approvalId:
              "approval_id" in params ? params.approval_id : undefined,
            assignmentId: target.assignment_id ?? undefined,
            reason: "rollback" in params ? params.rollback.reason : undefined,
          })
          return { deployment_id: row.id, config_version: row.configVersion }
        })
      )
    )

    await step.do("pointer", () =>
      run(() =>
        writePointer(this.env, target.host, {
          org_id: orgId,
          site_id: target.site_id,
          revision_id: target.revision_id,
          config_version: deployment.config_version,
        })
      )
    )

    // The content gate runs on the live HTML with the facts the assignment
    // was validated against; a rollback has no assignment and takes the
    // 5xx and blank-page checks alone.
    let failed: { minute: number; reason: string } | null = null
    for (const [i, minute] of PROBE_MINUTES.entries()) {
      if (i > 0) {
        const previous = PROBE_MINUTES[i - 1] ?? 0
        await step.sleep(
          `until minute ${minute}`,
          `${minute - previous} minutes`
        )
      }
      const result = await step.do(`probe ${minute}`, async () => {
        const assignmentId = target.assignment_id
        const factRecords = assignmentId
          ? await run((kit) => assignmentFacts(kit, { orgId, assignmentId }))
          : null
        const probe = await probeHost(target.host, factRecords)
        await run((kit) =>
          appendAudit(
            kit,
            { orgId, assignmentId: target.assignment_id },
            "publish.probed",
            { minute, revision_id: target.revision_id, ...probe }
          )
        )
        return probe
      })
      if (!result.ok) {
        failed = { minute, reason: result.reason }
        break
      }
    }

    if (failed && !rollback && target.previous_revision_id) {
      const back = target.previous_revision_id
      const why = failed
      const undone = await step.do("roll back", () =>
        run((kit) =>
          kit.withOrg({ orgId }, async (db) => {
            const row = await activate(db, orgId, {
              siteId: target.site_id,
              revisionId: back,
              kind: "rollback",
              reason: `probe ${why.minute}: ${why.reason}`,
            })
            await appendEvent(db, {
              orgId,
              assignmentId: target.assignment_id,
              staffId: null,
              type: "alert.raised",
              payload: {
                kind: "publish.rolled_back",
                revision_id: target.revision_id,
                restored_revision_id: back,
                minute: why.minute,
                reason: why.reason,
              },
            })
            return { config_version: row.configVersion }
          })
        )
      )
      await step.do("pointer after rollback", () =>
        run(() =>
          writePointer(this.env, target.host, {
            org_id: orgId,
            site_id: target.site_id,
            revision_id: back,
            config_version: undone.config_version,
          })
        )
      )
    } else if (failed) {
      const why = failed
      await step.do("alert", () =>
        run((kit) =>
          appendAudit(
            kit,
            { orgId, assignmentId: target.assignment_id },
            "alert.raised",
            {
              kind: "publish.probe_failed",
              revision_id: target.revision_id,
              minute: why.minute,
              reason: why.reason,
            }
          )
        )
      )
    }

    // A publish ends a site lock holder (§13): whoever queued behind it runs.
    const redriven = await step.do("redrive queued", () =>
      run((kit) => redriveQueued(this.env, kit, orgId))
    )
    return {
      outcome: failed ? "rolled_back" : "published",
      revision_id: target.revision_id,
      redriven,
    }
  }
}
