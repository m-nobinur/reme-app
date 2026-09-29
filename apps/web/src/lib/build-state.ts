import type { AssignmentState } from "@workspace/contracts"

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
