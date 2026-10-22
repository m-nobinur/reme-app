import type { TextStreamPart, ToolSet } from "ai"
import { voiceProblems } from "../voice.ts"

/** A dash read as a pause becomes a comma; one between numbers becomes "to". */
export const dashesToCommas = (text: string): string =>
  text.replace(/(\d)\s*[—–]\s*(\d)/g, "$1 to $2").replace(/\s*[—–]\s*/g, ", ")

/**
 * A model-written `step` as the panel may show it: whitespace collapsed,
 * dashes swapped, cut at 60, and gone when it names an id, a hash or a code.
 */
export function cleanStep(raw: string | undefined): string | undefined {
  const text = dashesToCommas(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
    .trimEnd()
  return text && voiceProblems(text).hard.length === 0 ? text : undefined
}

/**
 * The end of a delta that the next one may change: trailing space, a dash
 * with its spaces, and the digit before either (a range such as 9–5). A few
 * characters at most.
 */
const UNDECIDED = /(?:\d?\s*[—–]\s*|\d?\s+|\d)$/

/**
 * Passes the Chief of Staff's text straight through, swapping a dash for a
 * comma and holding back only the undecided end of a delta until the next
 * one arrives. The turn streams and cannot retry, so any other
 * `voiceProblems` hit on the finished text is logged once per text block
 * with the turn id, by kind and never by the owner's words, for the voice
 * eval to count. Placed in the stream before the SDK builds the message, so
 * the stored message and the log hold what the owner read.
 */
export const voiced =
  (turnId: string) =>
  <TOOLS extends ToolSet>() => {
    const blocks = new Map<string, { held: string; sent: string }>()
    return new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      transform(part, controller) {
        if (part.type === "text-delta") {
          const block = blocks.get(part.id) ?? { held: "", sent: "" }
          blocks.set(part.id, block)
          const text = block.held + part.text
          const tail = text.match(UNDECIDED)?.[0] ?? ""
          block.held = tail
          // A tail with a dash waits whole; a space or digit is only held back.
          const dashed = /[—–]/.test(tail)
          const done = dashesToCommas(
            dashed ? text.slice(0, text.length - tail.length) : text
          )
          const out = dashed ? done : done.slice(0, done.length - tail.length)
          if (!out) return
          block.sent += out
          controller.enqueue({ ...part, text: out })
          return
        }
        if (part.type === "text-end") {
          const block = blocks.get(part.id) ?? { held: "", sent: "" }
          blocks.delete(part.id)
          const out = dashesToCommas(block.held)
          if (out) {
            block.sent += out
            controller.enqueue({ type: "text-delta", id: part.id, text: out })
          }
          const { hard, soft } = voiceProblems(block.sent)
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
