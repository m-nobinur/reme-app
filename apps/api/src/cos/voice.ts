import type { TextStreamPart, ToolSet } from "ai"
import { voiceProblems } from "../voice.ts"

/**
 * Passes the Chief of Staff's text straight through. The turn streams and
 * cannot retry, so any `voiceProblems` hit on the finished text is logged
 * once per text block with the turn id, by kind and never by the owner's
 * words, for the voice eval to count.
 */
export const voiced =
  (turnId: string) =>
  <TOOLS extends ToolSet>() => {
    const blocks = new Map<string, string>()
    return new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      transform(part, controller) {
        if (part.type === "text-delta") {
          blocks.set(part.id, (blocks.get(part.id) ?? "") + part.text)
        }
        if (part.type === "text-end") {
          const sent = blocks.get(part.id) ?? ""
          blocks.delete(part.id)
          const { hard, soft } = voiceProblems(sent)
          if (hard.length + soft.length > 0) {
            console.warn(
              JSON.stringify({
                code: "cos.voice",
                turn_id: turnId,
                hard: hard.length,
                soft: soft.map((s) => s.replace(/ \(".*"\)\.$/, "")),
              })
            )
          }
        }
        controller.enqueue(part)
      },
    })
  }
