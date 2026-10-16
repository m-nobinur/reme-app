import type { AssignmentState, BuildActivity } from "@workspace/contracts"

/**
 * The row a build is on now: the one the api marks, else, rows running in
 * order, the first one not done. -1 once every row is done. A full count is
 * not the end of a step: every page written still has to pass the lead.
 */
export const currentRow = (rows: readonly BuildActivity[]) => {
  const marked = rows.findIndex((row) => row.now)
  return marked >= 0 ? marked : rows.findIndex((row) => row.done < row.total)
}

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
