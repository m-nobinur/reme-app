import { z } from "zod"
import { Uuid } from "./common.ts"
import { BuildStopCause } from "./owner.ts"
import { GateName } from "./report.ts"
import { Text } from "./text.ts"

/**
 * How the build pipeline tells the rest of the product what happened to a
 * build: every failure reason it records, and the notes its own steps write
 * as a build runs into trouble, starts again or finishes. The Chief of Staff
 * reads the notes, the panel shows them and the chat says them in the
 * assistant's own voice. No field holds text a model wrote.
 */

/** How a failed build is started again: from scratch with the same plan, from its last work with the failed checks named, or on the fallback model. */
export const RetryMode = z.enum(["same_plan", "fix_forward", "fallback_model"])

/**
 * Every reason the pipeline records on a failed build, with what the owner
 * is told and how it is retried; `retry: null` waits on the owner instead.
 * The one table both the pipeline and the api read.
 */
export const BUILD_FAILURES = {
  "gates.repair_budget_exhausted": {
    cause: "unfinished",
    retry: "fix_forward",
  },
  "gates.failed": { cause: "unfinished", retry: "fix_forward" },
  "developer.stalled": { cause: "stalled", retry: "same_plan" },
  "developer.timed_out": { cause: "stalled", retry: "same_plan" },
  "developer.no_report": { cause: "unfinished", retry: "same_plan" },
  "developer.start_failed": { cause: "service", retry: "same_plan" },
  "tool.repeating_failure": { cause: "unfinished", retry: "same_plan" },
  "provider.unavailable": { cause: "service", retry: "fallback_model" },
  "sandbox.updating": { cause: "service", retry: "same_plan" },
  "sandbox.site_lost": { cause: "service", retry: "same_plan" },
  "pool.exhausted": { cause: "service", retry: "same_plan" },
  "information.unanswered": { cause: "unanswered", retry: null },
  "blueprint.undecided": { cause: "unanswered", retry: null },
} as const satisfies Record<
  string,
  { cause: BuildStopCause; retry: RetryMode | null }
>

/** A failure reason's cause and retry, `other` and none for a reason the table does not hold. */
export function buildFailure(reason: string | null): {
  cause: BuildStopCause
  retry: RetryMode | null
} {
  return reason && Object.hasOwn(BUILD_FAILURES, reason)
    ? BUILD_FAILURES[reason as keyof typeof BUILD_FAILURES]
    : { cause: "other", retry: null }
}

/** The `events` type a note is stored under. */
export const AGENT_NOTE = "agent.note"

/**
 * One note from the pipeline about a build, written by its own steps:
 * - `problem`: a check failed and the Developer is fixing it (`attempt` of `of` repair rounds).
 * - `retrying`: the build failed on our side and `retry_id` starts it again.
 * - `stopped`: it could not finish; `next` says whether anything follows.
 * - `done`: the draft is ready to look at; `pages` names what was built.
 * `key` is the idempotency key the note and any chat post use.
 */
export const AgentNote = z.strictObject({
  kind: z.enum(["problem", "retrying", "stopped", "done"]),
  key: z.string().min(1).max(120),
  assignment_id: Uuid,
  attempt: z.int().min(1).max(9),
  of: z.int().min(1).max(9),
  cause: BuildStopCause.nullable(),
  next: z.enum(["repairing", "retrying", "waiting_owner", "none"]),
  failed: z.array(GateName).max(GateName.options.length),
  retry_id: Uuid.optional(),
  /** The pages a finished build made, by their owner-facing names. */
  pages: z.array(Text(40)).max(12).optional(),
})

export type RetryMode = z.infer<typeof RetryMode>
export type AgentNote = z.infer<typeof AgentNote>
