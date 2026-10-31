import { z } from "zod"
import { AssignmentState, InformationRequest } from "./assignment.ts"
import { Timestamp, Uuid } from "./common.ts"
import { Text } from "./text.ts"

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
  "copy",
  "a11y",
  "size",
  "interaction",
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
  /**
   * What the build left off the site for want of a fact, each asked as an
   * `ask_chief` question would be. Once the draft is ready the assistant
   * offers to add them. Absent on reports from before it existed.
   */
  left_out: z
    .array(
      InformationRequest.pick({
        field: true,
        answer_schema: true,
        options: true,
      }).extend({ question: InformationRequest.shape.question.unwrap() })
    )
    .max(10)
    .optional(),
  /**
   * False when the change could not be made the way the owner asked and the
   * nearest change was made instead, so the ready line does not claim it.
   * Absent means as asked, and on reports from before it existed.
   */
  as_asked: z.boolean().optional(),
  /**
   * What the change replaced on the built pages, read by code from the old
   * and new HTML, never the model. `before` is "" for new text and `after`
   * "" for removed text; an edit repeated across pages is one pair. Absent
   * on reports from before it existed and on a first build.
   */
  text_changes: z
    .array(
      z.strictObject({
        before: z.string().max(300),
        after: z.string().max(300),
        pages: z.array(z.string().min(1)).min(1).max(5),
      })
    )
    .max(8)
    .optional(),
  /** The pairs past the cap of 8. */
  text_changes_left: z.int().nonnegative().optional(),
  /** The Developer's reasons for the choices an owner may ask about, written before its session ends. */
  notes: z
    .array(
      z.strictObject({
        about: Text(80),
        why: Text(300),
      })
    )
    .max(8)
    .optional(),
  reported_at: Timestamp,
})

/**
 * A review of one built version: a reviewer's verdict on the stored
 * record, never the builder grading itself. A finding a stored check
 * produced is `from: "check"`. Stored in R2 beside the revision.
 */
export const SiteReview = z.strictObject({
  review_id: Uuid,
  org_id: Uuid,
  revision_id: Uuid,
  version: z.int().positive(),
  verdict: Text(300),
  strengths: z.array(Text(200)).max(4),
  findings: z
    .array(
      z.strictObject({
        /** Short and stable, such as "f1", so the owner can say "fix f2". */
        id: z.string().min(1).max(12),
        severity: z.enum(["high", "medium", "low"]),
        area: z.enum([
          "copy",
          "design",
          "accessibility",
          "links",
          "forms",
          "search",
          "content",
        ]),
        page: z.string().min(1).max(120),
        /** The text on the page it is about. */
        quote: Text(200).nullable(),
        issue: Text(300),
        fix: Text(300),
        from: z.enum(["check", "review"]),
      })
    )
    .max(20),
  findings_left: z.int().nonnegative(),
})

export type ProgressEvent = z.infer<typeof ProgressEvent>
export type GateName = z.infer<typeof GateName>
export type GateResult = z.infer<typeof GateResult>
export type ValidationReport = z.infer<typeof ValidationReport>
export type CompletionReport = z.infer<typeof CompletionReport>
export type SiteReview = z.infer<typeof SiteReview>
