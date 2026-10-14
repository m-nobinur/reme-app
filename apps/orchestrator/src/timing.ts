/**
 * The `revise.timing` line: one per assignment, milliseconds per step, written
 * when the Workflow ends so a slow build can be read off the log (QE1). Every
 * duration comes from a step's own return value or a durable stamp, never from
 * a clock held across steps, which a replay would reset.
 */
export type Timings = Record<string, number | string | boolean | null>

/** What `report_complete` measures and hands the Workflow with its wake-up. */
export type ToolTimings = {
  check_ms: number
  build_ms: number
  upload_ms: number
  /** Every file of the build. */
  upload_files: number
  /** Of those, the files copied inside R2 from the previous revision. */
  upload_reused: number
  /** Bytes read out of the sandbox, which the reused files are not. */
  upload_bytes: number
  source_ms: number
  /** Axe over the built pages in the sandbox. */
  axe_ms: number
  tool_ms: number
  model_turns: number | null
  /** Epoch ms when the tool woke the Workflow. */
  reported_at: number
}

/** Milliseconds since `started`, for a step body to return. */
export const since = (started: number) => Date.now() - started

export function logTiming(fields: Timings) {
  console.log(JSON.stringify({ type: "revise.timing", ...fields }))
}
