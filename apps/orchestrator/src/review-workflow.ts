import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers"
import { runReview, tellFailed, tellReview } from "./consult.ts"
import { withKit } from "./domain-flow.ts"
import { SAY_RETRIES } from "./domain-workflow.ts"
import { passWake } from "./schedule.ts"

export type ReviewParams = { org_id: string; revision_id: string }

/** One retry: a second failure costs a second reviewer call and tells nothing new. */
const REVIEW_STEP: WorkflowStepConfig = {
  retries: { limit: 1, delay: "10 seconds" },
  timeout: "5 minutes",
}

/**
 * One instance per version under review, `review-{revision_id}`, so a repeat
 * ask finds the one running. The review is one step (consult.ts), then the
 * report reaches the assistant as a proactive turn; a review that fails
 * tells the assistant so instead. Telling retries while a turn holds the chat.
 */
export class ReviewWorkflow extends WorkflowEntrypoint<Env, ReviewParams> {
  async run(event: WorkflowEvent<ReviewParams>, step: WorkflowStep) {
    const { org_id: orgId, revision_id: revisionId } = event.payload
    const env = this.env
    const tell = (fn: Parameters<typeof withKit>[1]) =>
      withKit(env, fn).then(() => passWake(env))
    let reviewed: Awaited<ReturnType<typeof runReview>>
    try {
      reviewed = await step.do("review", REVIEW_STEP, () =>
        withKit(env, (kit) => runReview(env, kit, orgId, revisionId))
      )
    } catch {
      await step.do("failed", SAY_RETRIES, () =>
        tell((kit) => tellFailed(kit, orgId, revisionId))
      )
      return { outcome: "failed" }
    }
    await step.do("tell", SAY_RETRIES, () =>
      tell((kit) => tellReview(kit, orgId, reviewed))
    )
    return { outcome: "reviewed" }
  }
}
