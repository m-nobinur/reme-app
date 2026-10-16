import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
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
  withKit,
} from "./domain-flow.ts"

/**
 * One instance per custom domain claim, `domain-{domain_id}`, connect path
 * only. It claims the two custom hostnames, then looks: at once, again on a
 * `check` nudge or after 2, 5, 15 and 30 minutes and hourly from then, until
 * the domain is ready, removed, or 72 hours old. Ready activates it; 72
 * hours fails it and frees the name. Steps carry ids only and every body is
 * in domain-flow.ts; this is the order.
 */
export class DomainWorkflow extends WorkflowEntrypoint<Env, DomainParams> {
  async run(event: WorkflowEvent<DomainParams>, step: WorkflowStep) {
    const { org_id: orgId, domain_id: domainId } = event.payload
    const env = this.env
    // The instance's creation time is durable; a clock read between steps
    // would move on every replay.
    const started = event.timestamp.getTime()
    const deadline = started + DEADLINE_MS

    const claimed = await step.do("hostnames", () =>
      withKit(env, (kit) => claimHostnames(env, kit, orgId, domainId))
    )
    if (claimed === "gone") return { outcome: "removed" }
    if (claimed === "held") {
      await step.do("held", () =>
        withKit(env, (kit) => expireDomain(env, kit, orgId, domainId, "held"))
      )
      return { outcome: "failed" }
    }

    let nudged = false
    for (let n = 1; ; n++) {
      const seen = await step.do(`look ${n}`, () =>
        withKit(env, (kit) => look(env, kit, orgId, domainId, n))
      )
      if (seen.gone) return { outcome: "removed" }
      if (seen.ready) break
      if (seen.at >= deadline) {
        await step.do("expire", () =>
          withKit(env, (kit) =>
            expireDomain(env, kit, orgId, domainId, "timeout")
          )
        )
        return { outcome: "failed" }
      }
      if (!nudged && seen.at - started >= NUDGE_AFTER_MS) {
        await step.do("nudge", () =>
          withKit(env, (kit) => nudge(kit, orgId, domainId))
        )
        nudged = true
      }
      try {
        await step.waitForEvent(`check ${n}`, {
          type: "check",
          timeout: Math.min(nextWait(n), deadline - seen.at),
        })
      } catch {
        // No nudge in time: look anyway.
      }
    }

    const live = await step.do("activate", () =>
      withKit(env, (kit) => activateDomain(env, kit, orgId, domainId))
    )
    return { outcome: live ? "active" : "removed" }
  }
}
