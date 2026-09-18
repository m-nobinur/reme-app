import { z } from "zod"
import { AssignmentState } from "./assignment.ts"
import { Timestamp, Uuid } from "./common.ts"

/**
 * A path inside the site workspace, as the model reports it. Relative, no
 * parent segments: this is model output crossing a trust boundary, and a
 * path that could name a file outside the site is refused at the contract.
 */
const SitePath = z
  .string()
  .min(1)
  .regex(/^(?!\/)(?!.*(^|\/)\.\.(\/|$)).+$/)

/** An R2 object key. Evidence, screenshots and artifacts are refs (R8). */
const ObjectKey = z.string().min(1)

/**
 * `ProgressEvent` (§19): runtime to event log, never owner-facing. It is the
 * payload of an `EventEnvelope`, which already carries the org, assignment,
 * session and time, so none of those are repeated here where they could
 * disagree with the envelope. `phase` is the facade's step name inside a
 * state (`restore`, `plan`, `edit`, `build`, `screenshot`); it becomes an
 * enum once the facade fixes that list.
 */
export const ProgressEvent = z.strictObject({
  state: AssignmentState,
  phase: z.string().min(1),
  metrics: z.record(z.string().min(1), z.number()),
})

/**
 * The gates `packages/gates` runs outside the sandbox (§8.5). An enum, not a
 * string: a misspelt gate must fail the contract, not silently pass the
 * report by being absent from it.
 */
export const GateName = z.enum([
  "build",
  "types",
  "links",
  "structured_data",
  "content",
  "claims",
])

export const GateResult = z.strictObject({
  gate: GateName,
  passed: z.boolean(),
  /** R2 key of the gate's output, when it wrote one. */
  evidence_key: ObjectKey.nullable(),
  /** The exact node a claim failed on, for the content and claims gates (§8.5). */
  offending_node: z.string().min(1).nullable(),
  message: z.string().min(1).nullable(),
})

/**
 * `ValidationReport` (§19): gates to orchestrator. There is no aggregate
 * `passed` field; the consumer derives it from the rows, so it can never
 * contradict them.
 */
export const ValidationReport = z.strictObject({
  report_id: Uuid,
  org_id: Uuid,
  assignment_id: Uuid,
  revision_id: Uuid,
  gates: z.array(GateResult).min(1),
  produced_at: Timestamp,
})

/**
 * `CompletionReport` (§19): Developer to CoS, through the orchestrator. Every
 * artifact is an R2 key. `checks` are the commands the `report_complete` tool
 * ran inside the sandbox, with their exit codes; they are not the gate's
 * `ValidationReport`, which C3 produces outside the sandbox and which is the
 * one that counts. Cost is not here: it is computed from the event log (§29.2).
 */
export const CompletionReport = z.strictObject({
  report_id: Uuid,
  org_id: Uuid,
  assignment_id: Uuid,
  session_id: Uuid,
  revision_id: Uuid,
  summary: z.string().min(1),
  changes: z
    .array(z.strictObject({ path: SitePath, reason: z.string().min(1) }))
    .min(1),
  /** R2 keys, one per viewport. */
  screenshots: z.array(ObjectKey),
  /** An empty block is refused: a report with nothing checked is not done. */
  checks: z
    .array(
      z.strictObject({
        check: z.string().min(1),
        exit_code: z.int().nonnegative(),
        output_key: ObjectKey.nullable(),
      })
    )
    .min(1),
  risks: z.array(z.string().min(1)),
  decisions_needed: z.array(z.string().min(1)),
  reported_at: Timestamp,
})

export type ProgressEvent = z.infer<typeof ProgressEvent>
export type GateName = z.infer<typeof GateName>
export type GateResult = z.infer<typeof GateResult>
export type ValidationReport = z.infer<typeof ValidationReport>
export type CompletionReport = z.infer<typeof CompletionReport>
