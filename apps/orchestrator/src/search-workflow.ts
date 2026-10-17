import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowSleepDuration,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers"
import { NonRetryableError } from "cloudflare:workflows"
import type { Tenancy } from "@workspace/db"
import { withKit } from "./domain-flow.ts"
import { SAY_RETRIES } from "./domain-workflow.ts"
import { GoogleError } from "./google.ts"
import {
  addProperty,
  announce,
  fileToken,
  markFailed,
  markVerified,
  placeToken,
  type SearchParams,
  verifyOnce,
} from "./search.ts"

/** Google's outage or quota, and our own database, retry; any other Google answer is final. */
export const GOOGLE_RETRIES: WorkflowStepConfig = {
  retries: { limit: 5, delay: "30 seconds", backoff: "exponential" },
  timeout: "1 minute",
}

/** KV writes take up to 60 s to reach other locations, and Google fetches from elsewhere. */
export const SETTLE: WorkflowSleepDuration = "60 seconds"
/** Three tries 30 s apart, then these waits, each followed by one more try. */
export const VERIFY_TRIES = 3
export const VERIFY_GAP: WorkflowSleepDuration = "30 seconds"
export const VERIFY_BACKOFF: WorkflowSleepDuration[] = [
  "10 minutes",
  "1 hour",
  "6 hours",
  "24 hours",
  "72 hours",
]

/** `work` with any Google answer but an outage made final, so only that and our own errors retry. */
async function final<T>(work: Promise<T>): Promise<T> {
  try {
    return await work
  } catch (error) {
    if (error instanceof GoogleError && error.name !== "google.unavailable") {
      throw new NonRetryableError(error.name)
    }
    throw error
  }
}

/**
 * One instance per `(org, host)`, `searchInstanceId`, started on connect.
 * It gets Google's verification file under the owner's account, has the
 * router serve it, verifies, adds the property and submits the sitemap, then
 * tells the owner once. A token Google refused (`NeedsReauth`) ends the
 * instance as errored with the connection already `needs_reauth`; the
 * reconnect restarts it. Bodies are in search.ts; this is the order.
 */
export class SearchWorkflow extends WorkflowEntrypoint<Env, SearchParams> {
  async run(event: WorkflowEvent<SearchParams>, step: WorkflowStep) {
    const params = event.payload
    const env = this.env
    const google =
      <T>(body: (kit: Tenancy) => Promise<T>) =>
      () =>
        final(withKit(env, body))

    const file = await step.do(
      "token",
      GOOGLE_RETRIES,
      google((kit) => fileToken(env, kit, params))
    )
    await step.do(
      "place",
      GOOGLE_RETRIES,
      google((kit) => placeToken(env, kit, params, file))
    )
    await step.sleep("settle", SETTLE)

    const waits: WorkflowSleepDuration[] = [
      ...Array.from({ length: VERIFY_TRIES - 1 }, () => VERIFY_GAP),
      ...VERIFY_BACKOFF,
    ]
    for (let n = 1; ; n++) {
      if (
        await step.do(
          `verify ${n}`,
          GOOGLE_RETRIES,
          google((kit) => verifyOnce(env, kit, params))
        )
      )
        break
      const wait = waits[n - 1]
      if (!wait) {
        await step.do(
          "failed",
          GOOGLE_RETRIES,
          google((kit) => markFailed(kit, params))
        )
        return { outcome: "failed" }
      }
      await step.sleep(`wait ${n}`, wait)
    }

    await step.do(
      "add",
      GOOGLE_RETRIES,
      google((kit) => addProperty(env, kit, params))
    )
    await step.do(
      "sitemap",
      GOOGLE_RETRIES,
      google((kit) => addProperty(env, kit, params, true))
    )
    await step.do(
      "verified",
      GOOGLE_RETRIES,
      google((kit) => markVerified(kit, params))
    )
    try {
      await step.do("announce", SAY_RETRIES, () =>
        withKit(env, (kit) => announce(kit, params))
      )
    } catch {
      // The chat stayed busy past every retry; the audit rows keep it.
    }
    return { outcome: "verified" }
  }
}
