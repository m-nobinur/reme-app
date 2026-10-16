/** States a watched assignment stops in: it waits on someone, or it is over. */
export const SETTLED = new Set([
  "preview_ready",
  "blocked_on_information",
  "blocked_on_approval",
  "published",
  "failed",
  "cancelled",
])

/**
 * The Blueprint round a build waits on the owner for, or null: the latest
 * `blueprint.proposed` asked for review and no `blueprint.decided` names its
 * round. Events in append order.
 */
export function awaitingRound(events) {
  const proposed = events.filter((e) => e.type === "blueprint.proposed").at(-1)
  const round = Number(proposed?.payload?.round)
  if (proposed?.payload?.review !== true || !round) return null
  const decided = events.some(
    (e) => e.type === "blueprint.decided" && Number(e.payload?.round) === round
  )
  return decided ? null : round
}
