import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers"
import { followUpElsewhere, lookElsewhere } from "./domain-buy.ts"
import { postStatus, type Say, withKit } from "./domain-flow.ts"
import { SAY_RETRIES } from "./domain-workflow.ts"
import { hold, probe } from "./probe.ts"

export type ElsewhereParams = { org_id: string; name: string }

const DAY_MS = 24 * 60 * 60 * 1000
/** When the owner hears one follow-up, if the registry still does not show the name. */
export const FOLLOW_UP_MS = 3 * DAY_MS
/** When the hold stops looking; the owner's word in chat still starts a connect. */
export const GIVE_UP_MS = 30 * DAY_MS

/**
 * One instance per org and name the owner buys themselves,
 * `elsewhere-{hash}`. It looks at the registry at once, then holds a day at a
 * time on the owner's `owner_done`, looking again after each wake or
 * timeout. The registry showing the name (or the owner connecting one) ends
 * it, with an offer to connect when nobody asked yet. After three days one
 * follow-up; after a month it stops. Every body is in domain-buy.ts.
 */
export class ElsewhereWorkflow extends WorkflowEntrypoint<
  Env,
  ElsewhereParams
> {
  async run(event: WorkflowEvent<ElsewhereParams>, step: WorkflowStep) {
    const { org_id: orgId, name } = event.payload
    const env = this.env
    const started = event.timestamp.getTime()
    const say = async (label: string, message: Say | null | undefined) => {
      if (!message) return
      try {
        await step.do(label, SAY_RETRIES, () =>
          withKit(env, (kit) => postStatus(kit, orgId, message))
        )
      } catch {
        // The chat stayed busy past every retry; the audit row keeps it.
      }
    }
    const look = (n: number) =>
      probe(step, `look ${n}`, env, { orgId, kind: "address" }, (kit) =>
        lookElsewhere(kit, orgId, name)
      )
    let followed = false
    let seen = await look(1)
    for (let n = 1; ; n++) {
      await say(`say ${n}`, seen.say)
      if (seen.registered || seen.claimed) return { outcome: "bought" }
      if (seen.at - started >= GIVE_UP_MS) return { outcome: "stopped" }
      if (!followed && seen.at - started >= FOLLOW_UP_MS) {
        const message = await step.do("follow up", () =>
          withKit(env, (kit) => followUpElsewhere(kit, orgId, name))
        )
        await say("say follow up", message)
        followed = true
      }
      ;({ seen } = await hold(
        step,
        `wait ${n}`,
        { type: "owner_done", timeout: DAY_MS },
        () => look(n + 1)
      ))
    }
  }
}
