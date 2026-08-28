/**
 * Langfuse exporter, off unless `LANGFUSE_SECRET_KEY` is set. Nothing sets it.
 *
 * §31.2 projects eval scores into Langfuse so datasets, experiments and
 * annotation queues can be built from them, with the Postgres event log staying
 * the source of truth. None of that pipeline exists. So this is a seam and not
 * an integration: off, it returns; on, it says what is missing rather than
 * dropping the payload or reporting a send that did not happen.
 */
export function exportRun(summary) {
  if (!process.env.LANGFUSE_SECRET_KEY) return { exported: false }
  throw new Error(
    `Langfuse export is not implemented: ${summary.scenarios} scenario ` +
      "results would have been dropped. Unset LANGFUSE_SECRET_KEY to run " +
      "evals without it."
  )
}
