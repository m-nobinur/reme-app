import type { AssignmentState, BuildActivity } from "@workspace/contracts"

/**
 * The row a build is on now: rows run in order, so it is the first one not
 * done. -1 once every row is done.
 */
export const currentRow = (rows: readonly BuildActivity[]) =>
  rows.findIndex((row) => row.done < row.total)

/**
 * The states in which a build is doing work: building, checking or
 * publishing. Not `queued`, which waits its turn, and none that wait on the
 * owner.
 */
export const WORKING: ReadonlySet<AssignmentState> = new Set([
  "briefing",
  "planning",
  "implementing",
  "validating",
  "revising",
  "repairing",
  "release_candidate",
])
