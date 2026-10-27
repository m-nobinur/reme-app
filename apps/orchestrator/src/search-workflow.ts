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
import { GoogleError, NeedsReauth } from "./google.ts"
import { probe } from "./probe.ts"
import {
  addProperty,
  announce,
  fileToken,
  markFailed,
  markVerified,
  placeToken,
  type SearchParams,
  sayVerifyFailed,
  tell,
  verifyOnce,
} from "./search.ts"
import { sayPayoff } from "./search-payoff.ts"
import {
  checkGrant,
  inspectPages,
  pullProperty,
  type SyncParams,
  syncTargets,
} from "./search-sync.ts"

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
    const task = { orgId: params.org_id, kind: "google" as const }
    for (let n = 1; ; n++) {
      const done = await probe(
        step,
        `verify ${n}`,
        env,
        task,
        async (kit) => {
          const verified = await final(verifyOnce(env, kit, params))
          return {
            result: verified,
            reading: {
              step: "verify",
              evidence: { host: params.host, verified },
            },
          }
        },
        GOOGLE_RETRIES
      )
      if (done) break
      const wait = waits[n - 1]
      if (!wait) {
        await step.do(
          "failed",
          GOOGLE_RETRIES,
          google((kit) => markFailed(kit, params))
        )
        await step
          .do("say failed", SAY_RETRIES, () =>
            withKit(env, (kit) => sayVerifyFailed(env, kit, params))
          )
          .catch(() => undefined) // a chat busy past every retry; the alert stands
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
        withKit(env, (kit) => announce(env, kit, params))
      )
    } catch {
      // The chat stayed busy past every retry; the audit rows keep it.
    }
    return { outcome: "verified" }
  }
}

/** A pull is three Google calls and the writes; a round of inspections is up to 20 calls. */
export const SYNC_RETRIES: WorkflowStepConfig = {
  ...GOOGLE_RETRIES,
  timeout: "5 minutes",
}

/**
 * One instance per org a day, `syncInstanceId`, started by the hourly sweep
 * (search-sync.ts). First the grant is checked (`checkGrant`): a revoked
 * token, a lost scope or lost Owner access blocks `permissions`, is said once
 * and ends the day. Then per verified property: the numbers, then the day's page
 * inspections; a property Google refuses is left `stale` and skipped. A
 * token Google refused ends it, with the connection already
 * `needs_reauth` and audited; tomorrow's instance finds no live connection.
 */
export class SearchSyncWorkflow extends WorkflowEntrypoint<Env, SyncParams> {
  async run(event: WorkflowEvent<SyncParams>, step: WorkflowStep) {
    const orgId = event.payload.org_id
    const env = this.env
    // A revoked token is an answer, not a failure: null, and the instance stops.
    const google =
      <T>(body: (kit: Tenancy) => Promise<T>) =>
      () =>
        final(
          withKit(env, (kit) =>
            body(kit).catch((error) => {
              if (error instanceof NeedsReauth) return null
              throw error
            })
          )
        )

    const grant = await probe(
      step,
      "permissions",
      env,
      { orgId, kind: "google" },
      (kit) => final(checkGrant(env, kit, orgId)),
      GOOGLE_RETRIES
    )
    if (grant.say) {
      const { key, text, button } = grant.say
      await step
        .do("say permissions", SAY_RETRIES, () =>
          withKit(env, (kit) =>
            tell(kit, orgId, key, { text: [text], ...(button && { button }) })
          )
        )
        .catch(() => undefined) // a chat busy past every retry; the step row keeps it
    }
    if (!grant.healthy) return { outcome: "needs_permission" }

    const sites = await step.do(
      "properties",
      GOOGLE_RETRIES,
      google((kit) => syncTargets(env, kit, orgId))
    )
    for (const [i, siteUrl] of (sites ?? []).entries()) {
      const pulled = await step.do(
        `pull ${i + 1}`,
        SYNC_RETRIES,
        google((kit) => pullProperty(env, kit, orgId, siteUrl))
      )
      if (!pulled) return { outcome: "needs_reauth" }
      // Google refused this property; the org's others still pull.
      if (pulled.stale) continue
      const inspected = await step.do(
        `inspect ${i + 1}`,
        SYNC_RETRIES,
        google((kit) => inspectPages(env, kit, orgId, siteUrl))
      )
      if (inspected === null) return { outcome: "needs_reauth" }
    }
    // The first numbers, or the day-10 check-in; a chat busy past every retry tries again tomorrow.
    await step
      .do("payoff", SAY_RETRIES, () =>
        withKit(env, (kit) => sayPayoff(kit, orgId))
      )
      .catch(() => undefined)
    return { outcome: "synced", properties: sites?.length ?? 0 }
  }
}
