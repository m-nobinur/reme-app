import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers"
import {
  abandonUnpaid,
  boughtReady,
  captureRegistered,
  finishSandbox,
  HOLD_MS,
  PAYMENT_ROUNDS,
  PAYMENT_WAIT,
  paymentState,
  readRegistration,
  registrationFailed,
  registrationWait,
  serveBought,
  servingStalled,
  startRegistration,
  subscribeRenewal,
} from "./domain-buy.ts"
import {
  activateDomain,
  claimHostnames,
  DEADLINE_MS,
  type DomainParams,
  expireDomain,
  look,
  NUDGE_AFTER_MS,
  nextWait,
  notServed,
  nudge,
  postStatus,
  repoint,
  type Say,
  SETTLE,
  served,
  withKit,
} from "./domain-flow.ts"
import { hold, probe } from "./probe.ts"
import { registrarLive } from "./registrar.ts"
import { startSearchForDomain } from "./search-start.ts"

const MINUTE = 60 * 1000
/** How long a bought domain may take to answer through the router before we flag it. */
export const SERVE_DEADLINE_MS = 24 * 60 * MINUTE

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
 * the domain is ready, removed, or 72 hours old. Each look is a probe
 * (probe.ts), so the owner hears only a check that changed. Ready activates
 * it, probes `loads` on the same schedule until the host serves the site,
 * says it is live and writes the pointers again after `SETTLE`; 72 hours
 * fails it and frees the name. A removal starts `domain-{domain_id}-removed`
 * with `settle`, which only writes the pointers again. A step body returns what to tell the owner
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
    const address = { orgId, kind: "address" as const }
    // Active, then said live only once the host serves the site, on the
    // claim's own schedule and deadline counted from the first `loads`.
    const live = async () => {
      const active = await step.do("activate", () =>
        withKit(env, async (kit) => {
          const done = await activateDomain(env, kit, orgId, domainId)
          if (done) await startSearchForDomain(env, kit, orgId, domainId)
          return done
        })
      )
      if (!active) return { outcome: "removed" }
      let since: number | undefined
      for (let n = 1; ; n++) {
        const loads = await probe(step, `loads ${n}`, env, address, (kit) =>
          served(env, kit, orgId, domainId)
        )
        if (loads.gone) return { outcome: "removed" }
        if (loads.ready) {
          await say("say live", loads.say)
          break
        }
        since ??= loads.at
        if (loads.at >= since + DEADLINE_MS) {
          const message = await step.do("not served", () =>
            withKit(env, (kit) => notServed(kit, orgId, domainId))
          )
          await say("say not served", message)
          return { outcome: "stalled" }
        }
        await step.sleep(`wait loads ${n}`, nextWait(loads.at - since))
      }
      await settle()
      return { outcome: "active" }
    }

    // A removal's own short instance: the route already wrote the pointers.
    if (event.payload.settle) {
      await settle()
      return { outcome: "removed" }
    }

    if (event.payload.buy) {
      // The payment: the row says paid before the event is sent, so a look
      // after each wait catches an event that came between them.
      for (let n = 1; ; n++) {
        const state = await step.do(`payment ${n}`, () =>
          withKit(env, (k) => paymentState(k, orgId, domainId))
        )
        if (state === "gone") return { outcome: "abandoned" }
        if (state === "paid") break
        if (n > PAYMENT_ROUNDS) {
          await step.do("abandon", () =>
            withKit(env, (k) => abandonUnpaid(k, orgId, domainId))
          )
          return { outcome: "abandoned" }
        }
        try {
          await step.waitForEvent(`paid ${n}`, {
            type: "paid",
            timeout: PAYMENT_WAIT,
          })
        } catch {
          // No payment in this round: look again.
        }
      }

      const begun = await step.do("register", () =>
        withKit(env, (k) => startRegistration(env, k, orgId, domainId))
      )
      if (begun.gone) return { outcome: "removed" }
      await say("say refused", begun.say)
      if (!begun.status) return { outcome: "failed" }
      let status = begun.status
      for (let n = 1; !status.completed; n++) {
        await step.sleep(`registering ${n}`, registrationWait(n))
        const read = await step.do(`registration ${n}`, () =>
          withKit(env, (k) => readRegistration(env, k, orgId, domainId))
        )
        if (read.gone) return { outcome: "removed" }
        status = read.status
        // The hold lapses at 7 days; release it before then.
        if (!status.completed && read.at >= started + HOLD_MS) break
      }
      if (status.state !== "succeeded") {
        const message = await step.do("not registered", () =>
          withKit(env, (k) =>
            registrationFailed(
              env,
              k,
              orgId,
              domainId,
              status.error?.code ?? status.state
            )
          )
        )
        await say("say failed", message)
        return { outcome: "failed" }
      }

      const registered = await step.do("capture", () =>
        withKit(env, (k) => captureRegistered(env, k, orgId, domainId))
      )
      await say("say registered", registered)
      await step.do("renewal", () =>
        withKit(env, (k) => subscribeRenewal(env, k, orgId, domainId))
      )
      if (!registrarLive(env)) {
        const message = await step.do("test", () =>
          withKit(env, (k) => finishSandbox(env, k, orgId, domainId))
        )
        await say("say test", message)
        return { outcome: "test" }
      }

      const serving = await step.do("serve", () =>
        withKit(env, (k) => serveBought(env, k, orgId, domainId))
      )
      if (!serving) return { outcome: "removed" }
      for (let n = 1; ; n++) {
        const seen = await step.do(`serving ${n}`, () =>
          withKit(env, (k) => boughtReady(k, orgId, domainId))
        )
        if (seen.gone) return { outcome: "removed" }
        if (seen.ready) break
        if (seen.at >= started + SERVE_DEADLINE_MS) {
          const message = await step.do("stalled", () =>
            withKit(env, (k) => servingStalled(k, orgId, domainId))
          )
          await say("say stalled", message)
          return { outcome: "stalled" }
        }
        await step.sleep(`wait serving ${n}`, nextWait(seen.at - started))
      }
      return live()
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

    // The first look asks Cloudflare to validate at once, for records already in.
    const lookAt = (n: number) =>
      probe(step, `look ${n}`, env, address, (kit) =>
        look(env, kit, orgId, domainId, n === 1)
      )
    let quietSince = started
    let nudged = false
    let checks = 0
    let seen = await lookAt(1)
    for (let n = 1; ; n++) {
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
      // A day after the claim last moved, once per quiet period, and only
      // while the owner is the one to act: a certificate being issued is ours.
      if (seen.changed) {
        quietSince = seen.at
        nudged = false
      }
      if (
        !nudged &&
        seen.status !== "pending_certificate" &&
        seen.at - quietSince >= NUDGE_AFTER_MS
      ) {
        const since = quietSince
        const message = await step.do("nudge", () =>
          withKit(env, (kit) => nudge(env, kit, orgId, domainId, since))
        )
        await say("say nudge", message)
        nudged = true
      }
      const wait = Math.min(nextWait(seen.at - started), deadline - seen.at)
      // Past `MAX_CHECKS` nudges the waits are sleeps, which are not steps.
      if (checks >= MAX_CHECKS) {
        await step.sleep(`wait ${n}`, wait)
        seen = await lookAt(n + 1)
        continue
      }
      const held = await hold(
        step,
        `check ${n}`,
        { type: "check", timeout: wait },
        () => lookAt(n + 1)
      )
      if (held.woken) checks++
      seen = held.seen
      // The owner's own check just said this in the chat: no second message.
      const told = (held.payload as { told?: string } | undefined)?.told
      if (told && "status" in seen && seen.status === told) {
        seen = { ...seen, say: undefined }
      }
    }
    return live()
  }
}
