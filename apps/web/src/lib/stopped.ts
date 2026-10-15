import type { BuildStopCause } from "@workspace/contracts"
import type { Workspace } from "./api/types"

/** Why a build stopped, mid-sentence, by the cause the api names. */
const WHY: Record<BuildStopCause, string> = {
  stalled: "it went quiet for too long",
  unfinished: "it could not finish a site that passes its checks",
  unanswered: "it waited too long for an answer",
  service: "a service it relies on kept failing",
  other: "something went wrong on our side",
}

/** What the owner is told about a failed build: why it stopped, then what to do. */
export const stoppedLines = (cause: BuildStopCause = "other"): string[] => [
  `The build stopped: ${WHY[cause]}.`,
  "Try again or ask for changes.",
]

/**
 * The newest failed build's lines, while it is the last thing that happened:
 * no build is open and nothing was published since. Null otherwise.
 */
export function stoppedOf(workspace: Workspace): string[] | null {
  if (workspace.open) return null
  const [newest] = workspace.attention
    .filter((item) => item.kind === "report" || item.kind === "alert")
    .sort((a, b) => Date.parse(b.raisedAt) - Date.parse(a.raisedAt))
  return newest?.kind === "alert" && newest.stopped
    ? stoppedLines(newest.stopped)
    : null
}
