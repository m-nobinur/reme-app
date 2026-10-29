import assert from "node:assert/strict"
import { test } from "node:test"
import {
  failures,
  judgePrompt,
  parseVerdicts,
  RULES,
  table,
  tally,
  verdictSchema,
} from "./behaviour.mjs"

const verdicts = (broken = {}, na = []) =>
  RULES.map((r) => ({
    id: r.id,
    applies: !na.includes(r.id),
    pass: !(r.id in broken),
    reason: broken[r.id] ?? "",
  }))

const reply = (list) => JSON.stringify({ verdicts: list })

test("a verdict list covers every rule once, in the rules' order", () => {
  const got = parseVerdicts(`Here: ${reply([...verdicts()].reverse())}`)
  assert.deepEqual(
    got.map((v) => v.id),
    RULES.map((r) => r.id)
  )
  assert.equal(
    verdictSchema().schema.properties.verdicts.items.properties.id.enum.length,
    RULES.length
  )
})

test("a missing, repeated or non-boolean verdict throws rather than passes", () => {
  assert.throws(() => parseVerdicts(reply(verdicts().slice(1))), /missing/)
  assert.throws(
    () => parseVerdicts(reply([...verdicts().slice(1), verdicts()[1]])),
    /missing|once/
  )
  assert.throws(
    () => parseVerdicts(reply(verdicts().map((v) => ({ ...v, pass: "yes" })))),
    /boolean/
  )
  assert.throws(() => parseVerdicts("no json here"), /no JSON/)
})

test("the tally counts pass, fail, not applicable and pending apart", () => {
  const graded = [
    { name: "a", verdicts: verdicts({ voice: "an exclamation mark" }) },
    { name: "b", verdicts: verdicts({}, ["standing", "no_widen"]) },
    { name: "c", pending: true, verdicts: verdicts({ evidence: "no 200" }) },
    { name: "d", error: "no result" },
  ]
  const row = (id) => tally(graded).find((r) => r.id === id)
  assert.deepEqual(row("voice"), {
    id: "voice",
    pass: 2,
    fail: 1,
    na: 0,
    pending: 0,
  })
  assert.deepEqual(row("evidence"), {
    id: "evidence",
    pass: 2,
    fail: 0,
    na: 0,
    pending: 1,
  })
  assert.deepEqual(row("standing"), {
    id: "standing",
    pass: 2,
    fail: 0,
    na: 1,
    pending: 0,
  })
})

test("a broken rule or an ungraded case in a gated case fails the run; a pending one does not", () => {
  const graded = [
    { name: "a", verdicts: verdicts({ voice: "a sign-off" }) },
    { name: "b", error: "bad reply" },
    { name: "c", pending: true, verdicts: verdicts({ evidence: "no 200" }) },
    { name: "d", pending: true, error: "bad reply" },
    { name: "e", verdicts: verdicts({ voice: "ignored" }, ["voice"]) },
  ]
  assert.deepEqual(failures(graded), [
    "a: voice (a sign-off)",
    "b: not graded (bad reply)",
  ])
  const out = table(graded, 0.01)
  assert.match(out, /\| voice \| 1 \| 1 \| 0 \| 1 \|/)
  assert.match(out, /c \(pending\), evidence: no 200/)
})

test("a standing request saved in an earlier turn reaches the judge's profile", () => {
  const turns = [
    {
      owner: { mode: "act", text: "No exclamation marks, please." },
      parts: [
        {
          type: "tool",
          toolName: "remember",
          input: { operations: [{ text: 'Asked: "No exclamation marks"' }] },
        },
        { type: "text", text: "Understood." },
      ],
    },
  ]
  const { user, system } = judgePrompt({ turns: [] }, turns)
  assert.match(user, /Asked: "No exclamation marks"/)
  assert.match(user, /CoS: Understood\./)
  assert.match(system, /Chief of Staff/)
})
