import assert from "node:assert/strict"
import { test } from "node:test"
import {
  diffLines,
  parseEditsJson,
  parseRecords,
  relacePrompt,
  score,
  summarise,
  unfence,
} from "./measures.mjs"

test("diffLines lists only the changed lines", () => {
  assert.deepEqual(diffLines("a\nb\nc", "a\nB\nc"), ["-b", "+B"])
  assert.deepEqual(diffLines("a\nb", "a\nb"), [])
  assert.deepEqual(diffLines("a\nc", "a\nb\nc"), ["+b"])
  assert.deepEqual(diffLines("a\nb\nc", "a\nc"), ["-b"])
})

test("score separates requested from unrequested changes", () => {
  const orig = "a\nb\nc\nd"
  const expected = "a\nB\nc\nd"
  assert.deepEqual(score(orig, expected, expected), {
    changed: 2,
    unrequested: 0,
    missed: 0,
  })
  // also touched d: two unrequested lines
  assert.deepEqual(score(orig, "a\nB\nc\nD", expected), {
    changed: 4,
    unrequested: 2,
    missed: 0,
  })
  // did nothing: the request is missed
  assert.deepEqual(score(orig, orig, expected), {
    changed: 0,
    unrequested: 0,
    missed: 2,
  })
  assert.deepEqual(score(orig, expected), {
    changed: 2,
    unrequested: null,
    missed: null,
  })
})

test("score counts a doubled line twice", () => {
  const orig = "a\nb"
  assert.equal(score(orig, "a\nB\nB", "a\nB").unrequested, 1)
})

test("parseRecords checks every field and names the line", () => {
  const ok = JSON.stringify({ path: "a.ts", original: "x", instruction: "y" })
  assert.equal(parseRecords(`${ok}\n\n${ok}`).records.length, 2)
  const bad = parseRecords(
    `${ok}\nnot json\n${JSON.stringify({ path: "a", original: "", instruction: "y", expected: 3 })}`
  )
  assert.deepEqual(bad.problems, [
    "line 2: not JSON",
    "line 3: original must be a non-empty string",
    "line 3: expected must be a string when present",
  ])
  assert.deepEqual(parseRecords("").problems, ["no records"])
})

test("parseEditsJson takes a fenced reply and refuses a malformed one", () => {
  const edits = [{ oldText: "a", newText: "b" }]
  assert.deepEqual(
    parseEditsJson(`\`\`\`json\n${JSON.stringify({ edits })}\n\`\`\``),
    edits
  )
  assert.throws(() => parseEditsJson('{"edits":[]}'))
  assert.throws(() => parseEditsJson('{"edits":[{"oldText":"a"}]}'))
})

test("relace prompt is the three tags in order; unfence strips one fence", () => {
  assert.equal(
    relacePrompt("i", "c", "u"),
    "<instruction>i</instruction>\n<code>c</code>\n<update>u</update>"
  )
  assert.equal(unfence("```css\na{}\n```"), "a{}")
  assert.equal(unfence("a{}"), "a{}")
})

test("summarise aggregates per path", () => {
  const [s] = summarise([
    { path: "p", ok: true, ms: 100, cost: 0.01, unrequested: 1, missed: 0 },
    { path: "p", ok: false, ms: 300, cost: 0 },
    { path: "p", ok: true, ms: 200, cost: 0.02, unrequested: 0, missed: 2 },
  ])
  assert.deepEqual(s, {
    path: "p",
    n: 3,
    applied: 2,
    medianMs: 200,
    unrequested: 1,
    missed: 2,
    cost: 0.03,
  })
})
