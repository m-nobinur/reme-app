import { FacadeError } from "./errors.ts"

export type Edit = { oldText: string; newText: string }

/*
 * Ported from Pi's coding agent, `packages/coding-agent/src/core/tools/edit-diff.ts`
 * and `edit.ts` at earendil-works/pi 8a7b0c0 (0.85.1), MIT, Copyright (c) 2025
 * Mario Zechner. The matching rules and the messages are Pi's, verbatim; the
 * file system and the diff rendering are left behind because the tool reads
 * and writes through the sandbox.
 */

const BOM = "﻿"

const lineEnding = (text: string): "\r\n" | "\n" => {
  const crlf = text.indexOf("\r\n")
  const lf = text.indexOf("\n")
  return lf !== -1 && crlf !== -1 && crlf < lf ? "\r\n" : "\n"
}

const toLF = (text: string) => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")

/** Pi's forgiving view: trailing whitespace, smart quotes, dashes and odd spaces. Leading indentation is never forgiven. */
function normalizeForMatch(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[  -   　]/g, " ")
}

type Match = { index: number; start: number; length: number; newText: string }

const refuse = (code: string, message: string, detail = {}) =>
  new FacadeError(code, "validation", message, detail)

const linesWithEndings = (text: string) => text.match(/[^\n]*\n|[^\n]+/g) ?? []

function replaceAll(text: string, matches: Match[], offset = 0): string {
  let out = text
  for (const m of [...matches].sort((a, b) => b.start - a.start)) {
    const at = m.start - offset
    out = out.slice(0, at) + m.newText + out.slice(at + m.length)
  }
  return out
}

/**
 * When a match needed the forgiving view, rewrite only the lines the matches
 * touch from that view and copy every other line from the original, so an
 * edit never strips whitespace from a line it did not change.
 */
function preservingUntouchedLines(
  original: string,
  base: string,
  matches: Match[]
): string {
  const originalLines = linesWithEndings(original)
  let offset = 0
  const spans = linesWithEndings(base).map((line) => {
    const span = { start: offset, end: offset + line.length }
    offset = span.end
    return span
  })
  const groups: { first: number; last: number; matches: Match[] }[] = []
  for (const m of [...matches].sort((a, b) => a.start - b.start)) {
    const first = spans.findIndex((s) => m.start >= s.start && m.start < s.end)
    let last = first
    while (
      last < spans.length - 1 &&
      (spans[last]?.end ?? 0) < m.start + m.length
    )
      last++
    const current = groups.at(-1)
    if (current && first <= current.last) {
      current.last = Math.max(current.last, last)
      current.matches.push(m)
    } else {
      groups.push({ first, last, matches: [m] })
    }
  }
  let out = ""
  let next = 0
  for (const g of groups) {
    out += originalLines.slice(next, g.first).join("")
    const from = spans[g.first]?.start ?? 0
    const to = spans[g.last]?.end ?? base.length
    out += replaceAll(base.slice(from, to), g.matches, from)
    next = g.last + 1
  }
  return out + originalLines.slice(next).join("")
}

/**
 * The batch point edit (§8.2 "Edit without rewriting files"). Every `oldText`
 * is matched against the file as it is, exactly first and then in Pi's
 * forgiving view; each must match once, no two may overlap, and a refusal
 * writes nothing, so a retry starts from the file the model last read. BOM
 * and CRLF are stripped for matching and put back.
 */
export function applyEdits(
  content: string,
  edits: readonly Edit[],
  path: string
): string {
  if (edits.length === 0) {
    throw refuse(
      "edit.empty",
      "Edit tool input is invalid. edits must contain at least one replacement."
    )
  }
  const single = edits.length === 1
  const bom = content.startsWith(BOM) ? BOM : ""
  const text = content.slice(bom.length)
  const ending = lineEnding(text)
  const lf = toLF(text)
  const wanted = edits.map((e) => ({
    oldText: toLF(e.oldText),
    newText: toLF(e.newText),
  }))

  wanted.forEach((e, i) => {
    if (e.oldText.length === 0) {
      throw refuse(
        "edit.empty_match",
        single
          ? `oldText must not be empty in ${path}.`
          : `edits[${i}].oldText must not be empty in ${path}.`,
        { index: i }
      )
    }
  })

  const forgiving = wanted.some((e) => !lf.includes(e.oldText))
  const base = forgiving ? normalizeForMatch(lf) : lf
  const matches: Match[] = wanted.map((e, i) => {
    const needle = forgiving ? normalizeForMatch(e.oldText) : e.oldText
    const start = base.indexOf(needle)
    if (start === -1) {
      throw refuse(
        "edit.not_found",
        single
          ? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
          : `Could not find edits[${i}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
        { index: i }
      )
    }
    const occurrences =
      normalizeForMatch(base).split(normalizeForMatch(e.oldText)).length - 1
    if (occurrences > 1) {
      throw refuse(
        "edit.ambiguous",
        single
          ? `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
          : `Found ${occurrences} occurrences of edits[${i}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
        { index: i, occurrences }
      )
    }
    return { index: i, start, length: needle.length, newText: e.newText }
  })

  const ordered = [...matches].sort((a, b) => a.start - b.start)
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1] as Match
    const cur = ordered[i] as Match
    if (prev.start + prev.length > cur.start) {
      throw refuse(
        "edit.overlap",
        `edits[${prev.index}] and edits[${cur.index}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
        { indices: [prev.index, cur.index] }
      )
    }
  }

  const next = forgiving
    ? preservingUntouchedLines(lf, base, matches)
    : replaceAll(base, matches)
  if (next === lf) {
    throw refuse(
      "edit.unchanged",
      single
        ? `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
        : `No changes made to ${path}. The replacements produced identical content.`
    )
  }
  return bom + (ending === "\r\n" ? next.replace(/\n/g, "\r\n") : next)
}
