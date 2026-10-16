import type { DecisionOutcome } from "./api/types"

/** Why a decision was refused, in the owner's words. */
export const DECISION_REFUSED: Record<
  Exclude<DecisionOutcome, { recorded: true }>["reason"],
  string
> = {
  expired:
    "That review expired before your answer reached it, so nothing was published.",
  replaced:
    "A newer version replaced that one. Check the latest before you decide.",
  gone: "That is no longer waiting on you. It was already decided, or the build stopped.",
  checking: "Checking accessibility. Approve again in a few seconds.",
}
