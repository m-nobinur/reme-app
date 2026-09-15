import { z } from "zod"
import { FacadeError } from "./errors.ts"

export type Edit = { oldText: string; newText: string }

/** The batch edit tool's input, in zod so `toolInput` derives the model-facing schema. */
export const BatchEditInput = z.strictObject({
  path: z.string().min(1),
  edits: z
    .array(z.strictObject({ oldText: z.string().min(1), newText: z.string() }))
    .min(1),
})

/**
 * The batch point edit (§8.2 "Edit without rewriting files", Pi's shape):
 * every `oldText` must match exactly once in the original, the matches may
 * not overlap, and each is matched against the original rather than the
 * running result, so one call carries many edits and the model returns only
 * the changed regions. The refusals name what the model has to fix.
 */
export function applyEdits(original: string, edits: readonly Edit[]): string {
  if (edits.length === 0) {
    throw new FacadeError("edit.empty", "validation", "no edits were given")
  }
  const spans: { start: number; end: number; newText: string }[] = []
  edits.forEach(({ oldText, newText }, i) => {
    if (oldText.length === 0) {
      throw new FacadeError(
        "edit.empty_match",
        "validation",
        `edit ${i + 1}: oldText is empty`
      )
    }
    const first = original.indexOf(oldText)
    if (first === -1) {
      throw new FacadeError(
        "edit.not_found",
        "validation",
        `edit ${i + 1}: oldText was not found; check whitespace and indentation match the file exactly`,
        { index: i }
      )
    }
    if (original.indexOf(oldText, first + 1) !== -1) {
      throw new FacadeError(
        "edit.ambiguous",
        "validation",
        `edit ${i + 1}: oldText matches more than once; include more surrounding context`,
        { index: i }
      )
    }
    spans.push({ start: first, end: first + oldText.length, newText })
  })
  spans.sort((a, b) => a.start - b.start)
  for (let i = 1; i < spans.length; i++) {
    const prev = spans[i - 1]
    const span = spans[i]
    if (prev && span && span.start < prev.end) {
      throw new FacadeError(
        "edit.overlap",
        "validation",
        "two edits overlap; merge them into one",
        { at: span.start }
      )
    }
  }
  let out = ""
  let cursor = 0
  for (const span of spans) {
    out += original.slice(cursor, span.start) + span.newText
    cursor = span.end
  }
  return out + original.slice(cursor)
}
