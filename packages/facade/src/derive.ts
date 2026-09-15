import type { EventEnvelope } from "@workspace/contracts"
import { canonicalHash } from "./canonical.ts"

/**
 * §10.6: the context a model saw is a pure function of the session's log.
 * The fold keeps what reached the model, in `seq` order: the stable segment
 * the facade rendered, each turn's assistant message and tool results, and
 * each compaction summary. Framing events carry no model-visible state and
 * are skipped, so the hash depends on what was said, not on how it was
 * chunked. Nothing here reads a clock, a random source or the environment.
 */
export type DerivedContext = {
  parts: Array<
    | { kind: "segment"; payload: Record<string, unknown> }
    | { kind: "turn"; message: unknown; tool_results: unknown }
    | { kind: "compaction"; payload: Record<string, unknown> }
  >
}

export function deriveContext(
  events: readonly EventEnvelope[]
): DerivedContext {
  const ordered = [...events]
    .filter((e) => e.seq !== null)
    .sort((a, b) => (a.seq as number) - (b.seq as number))
  const parts: DerivedContext["parts"] = []
  for (const event of ordered) {
    switch (event.type) {
      case "runtime.context_segment":
        parts.push({ kind: "segment", payload: event.payload })
        break
      case "runtime.turn_messages":
        parts.push({
          kind: "turn",
          message: event.payload.message,
          tool_results: event.payload.toolResults,
        })
        break
      case "runtime.compaction":
        parts.push({ kind: "compaction", payload: event.payload })
        break
      default:
        break
    }
  }
  return { parts }
}

/** The hash a recorded session is pinned to. */
export const contextHash = (events: readonly EventEnvelope[]) =>
  canonicalHash(deriveContext(events))
