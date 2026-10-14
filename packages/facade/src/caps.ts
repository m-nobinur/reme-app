import { contentText, type Message } from "@earendil-works/pi-ai"

/**
 * A role's output cap on the wire. flue gives the transport no role and sets
 * no cap of its own, so a Sonnet call from the lead (32k) and from a page
 * builder (16k) look the same to it. What tells them apart is the system
 * prompt: flue puts a session's instructions first in it (skills, agents and
 * the date follow), and each role renders its own. The agent registers its
 * instructions with the cap its role has in the signed routing table; the
 * transport looks a call's system prompt up here before it falls back to the
 * largest cap for the model.
 */

/** Prompts of the builds in flight, oldest first. Each build adds a few and the isolate lives long. */
const MAX_ROLES = 16
const caps = new Map<string, number>()

/** Returns `instructions` unchanged, so an agent can register while it returns them. */
export function withOutputCap(instructions: string, maxTokens: number): string {
  // Re-registering moves it to the newest.
  caps.delete(instructions)
  caps.set(instructions, maxTokens)
  for (const oldest of caps.keys()) {
    if (caps.size <= MAX_ROLES) break
    caps.delete(oldest)
  }
  return instructions
}

/**
 * The cap of the role whose instructions begin a call's system prompt, which
 * is the leading system message: the longest registered match, so a role
 * whose prompt starts another's still wins its own.
 */
export function registeredCap(messages: readonly Message[]) {
  const lead = messages[0]
  if (lead?.role !== "system") return undefined
  const prompt = contentText(lead.content)
  let best: { length: number; cap: number } | undefined
  for (const [instructions, cap] of caps) {
    if (
      prompt.startsWith(instructions) &&
      instructions.length > (best?.length ?? -1)
    ) {
      best = { length: instructions.length, cap }
    }
  }
  return best?.cap
}
