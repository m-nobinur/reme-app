import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers"
import { NonRetryableError } from "cloudflare:workflows"
import { type Tenancy, tenancy } from "@workspace/db"
import { advance, claim, TransitionError } from "./state.ts"
import { stubDeveloper, stubGates } from "./stub.ts"

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

    await step.do("planning", () => run((kit) => advance(kit, ids, "planning")))
    await step.do("implementing", () =>
      run((kit) => advance(kit, ids, "implementing"))
    )
    await step.do("developer", () => run((kit) => stubDeveloper(kit, ids)))
    await step.do("validating", () => run((kit) => stubGates(kit, ids)))
    return { outcome: "preview_ready" }
  }
}
