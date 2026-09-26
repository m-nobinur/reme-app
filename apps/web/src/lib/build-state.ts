import type { AssignmentState, BuildSummary } from "@workspace/contracts"

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

/** The build doing work now, if any. */
export const runningBuild = (builds: BuildSummary[]) =>
  builds.find((build) => WORKING.has(build.state))
