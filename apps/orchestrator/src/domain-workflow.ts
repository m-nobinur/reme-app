import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers"
import {
  activateDomain,
  claimHostnames,
  DEADLINE_MS,
  type DomainParams,
  expireDomain,
  look,
  NUDGE_AFTER_MS,
  nextWait,
  nudge,
  postStatus,
  repoint,
  type Say,
  SETTLE,
  withKit,
} from "./domain-flow.ts"

const MINUTE = 60 * 1000

/**
 * How many `check` nudges a claim honours. With the schedule's ~110 looks a
 * claim spends ~230 steps over 72 hours; each nudge adds a look and a wait,
 * so this keeps the worst case near 550, inside even the 1,024 a Free plan
 * Workflow gets (10,000 on Paid).
 */
export const MAX_CHECKS = 100

/**
 * A message waits while the owner's chat is in a turn or holds an unanswered
 * card, which can be days: 10 s doubling to a 30-minute cap, about four days
 * of tries in all. Past that the message is dropped and its `domain.status`
 * row is the record.
 */
export const SAY_RETRIES: WorkflowStepConfig = {
  retries: {
    limit: 200,
    delay: ({ ctx }) => Math.min(10_000 * 2 ** (ctx.attempt - 1), 30 * MINUTE),
  },
  timeout: "1 minute",
}

/**
 * One instance per custom domain claim, `domain-{domain_id}`, connect path
 * only. It claims the two custom hostnames, then looks: at once, again on a
 * `check` nudge or on `nextWait`'s schedule (every minute for the first half
 * hour, every 10 minutes to two hours, hourly from then), until
 * the domain is ready, removed, or 72 hours old. Ready activates it and
 * writes the pointers again after `SETTLE`; 72 hours fails it and frees the
 * name. A removal starts `domain-{domain_id}-removed` with `settle`, which
 * only writes the pointers again. A step body returns what to tell the owner
 * and a `say` step posts it, so a busy chat retries the post alone. Steps
 * carry ids only and every body is in domain-flow.ts; this is the order.
 */
export class DomainWorkflow extends WorkflowEntrypoint<Env, DomainParams> {
  async run(event: WorkflowEvent<DomainParams>, step: WorkflowStep) {
    const { org_id: orgId, domain_id: domainId } = event.payload
    const env = this.env
    // The instance's creation time is durable; a clock read between steps
    // would move on every replay.
    const started = event.timestamp.getTime()
    const deadline = started + DEADLINE_MS
    const settle = async () => {
      await step.sleep("settle", SETTLE)
      await step.do("pointers again", () =>
        withKit(env, (kit) => repoint(env, kit, orgId, domainId))
      )
    }
    const say = async (name: string, message: Say | null | undefined) => {
      if (!message) return
      try {
        await step.do(name, SAY_RETRIES, () =>
          withKit(env, (kit) => postStatus(kit, orgId, message))
        )
      } catch {
        // The chat stayed busy past every retry; the audit row keeps it.
      }
    }

    // A removal's own short instance: the route already wrote the pointers.
    if (event.payload.settle) {
      await settle()
      return { outcome: "removed" }
    }

    const claimed = await step.do("hostnames", () =>
      withKit(env, (kit) => claimHostnames(env, kit, orgId, domainId))
    )
    if (claimed === "gone") return { outcome: "removed" }
    if (claimed === "held") {
      const message = await step.do("held", () =>
        withKit(env, (kit) => expireDomain(env, kit, orgId, domainId, "held"))
      )
      await say("say held", message)
      return { outcome: "failed" }
    }

    let nudged = false
    let checks = 0
    for (let n = 1; ; n++) {
      const seen = await step.do(`look ${n}`, () =>
        withKit(env, (kit) => look(env, kit, orgId, domainId, n))
      )
      if (seen.gone) return { outcome: "removed" }
      await say(`say ${n}`, seen.say)
      if (seen.ready) break
      if (seen.at >= deadline) {
        const message = await step.do("expire", () =>
          withKit(env, (kit) =>
            expireDomain(env, kit, orgId, domainId, "timeout")
          )
        )
        await say("say failed", message)
        return { outcome: "failed" }
      }
      if (!nudged && seen.at - started >= NUDGE_AFTER_MS) {
        const message = await step.do("nudge", () =>
          withKit(env, (kit) => nudge(kit, orgId, domainId))
        )
        await say("say nudge", message)
        nudged = true
      }
      const wait = Math.min(nextWait(seen.at - started), deadline - seen.at)
      // Past `MAX_CHECKS` nudges the waits are sleeps, which are not steps.
      if (checks >= MAX_CHECKS) {
        await step.sleep(`wait ${n}`, wait)
        continue
      }
      try {
        await step.waitForEvent(`check ${n}`, { type: "check", timeout: wait })
        checks++
      } catch {
        // No nudge in time: look anyway.
      }
    }

    const live = await step.do("activate", () =>
      withKit(env, (kit) => activateDomain(env, kit, orgId, domainId))
    )
    if (!live) return { outcome: "removed" }
    await say("say live", live)
    await settle()
    return { outcome: "active" }
  }
}
