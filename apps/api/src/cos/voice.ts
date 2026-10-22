import type { TextStreamPart, ToolSet } from "ai"
import { voiceProblems } from "../voice.ts"

/** A dash read as a pause becomes a comma; one between numbers becomes "to". */
export const dashesToCommas = (text: string): string =>
  text.replace(/(\d)\s*[—–]\s*(\d)/g, "$1 to $2").replace(/\s*[—–]\s*/g, ", ")

/** The longest start of `text` that ends a sentence: its stop, any closing quote, then a space. */
function wholeSentences(text: string): string {
  let end = 0
  for (const mark of text.matchAll(/[.!?]["'”’)]*(?=\s)/g)) {
    end = mark.index + mark[0].length
  }
  return text.slice(0, end)
}

/**
 * Holds the Chief of Staff's text to the end of each sentence, so a dash
 * is swapped before the owner reads it. The turn streams and cannot retry,
 * so any other `voiceProblems` hit is logged once per text block with the
 * turn id, by kind and never by the owner's words, for the voice eval to count.
 * Placed in the stream before the SDK builds the message, so the stored
 * message and the log hold what the owner read.
 */
export const voiced =
  (turnId: string) =>
  <TOOLS extends ToolSet>() => {
    const held = new Map<string, { waiting: string; sent: string }>()
    return new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      transform(part, controller) {
        if (part.type === "text-start")
          held.set(part.id, { waiting: "", sent: "" })
        if (part.type === "text-delta") {
          const text = held.get(part.id) ?? { waiting: "", sent: "" }
          held.set(part.id, text)
          text.waiting += part.text
          const whole = wholeSentences(text.waiting)
          if (!whole) return
          text.waiting = text.waiting.slice(whole.length)
          const out = dashesToCommas(whole)
          text.sent += out
          controller.enqueue({ ...part, text: out })
          return
        }
        if (part.type === "text-end") {
          const text = held.get(part.id)
          held.delete(part.id)
          if (text?.waiting) {
            const out = dashesToCommas(text.waiting)
            text.sent += out
            controller.enqueue({
              type: "text-delta",
              id: part.id,
              text: out,
            })
          }
          const { hard, soft } = voiceProblems(text?.sent ?? "")
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
