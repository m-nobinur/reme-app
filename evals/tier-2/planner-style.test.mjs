import assert from "node:assert/strict"
import { test } from "node:test"
import { listsOf, styleHits } from "./planner-style.mjs"

const SERVICES =
  "We're a tree surgery and garden care company in Leeds. Main jobs are tree pruning and crown reductions, tree felling, hedge trimming and stump grinding."
const owner = new Set(
  SERVICES.toLowerCase()
    .match(/[\p{L}']+/gu)
    .map((w) => w.replace(/(?<!s)s$/, ""))
)
const context = { typed: SERVICES, lists: listsOf(SERVICES), owner }

test("each pattern is seen, and a clean reply holds none", () => {
  const cases = {
    "bold question": "**Where do you work?** A town is plenty.",
    "noted opener": "Stump grinding and the rest, noted.",
    echo: "Main jobs are tree pruning and crown reductions, I see.",
    "partial list": "Stump grinding and tree surgery, I'll ask about access.",
    "read-back":
      "So tree pruning and crown reductions, tree felling, hedge trimming and stump grinding.",
    "sign-off": "Let me know if anything is wrong.",
    outcome: "I'll ask about access so the quote is right.",
  }
  const lists = { ...context, services: listsOf(SERVICES)[0] }
  for (const [name, say] of Object.entries(cases))
    assert.ok(styleHits(say, lists).includes(name), `${name}: ${say}`)
  assert.deepEqual(
    styleHits(
      "Pruning right through to stump grinding. Where do you work?",
      lists
    ),
    []
  )
})

test("a reply request counts only above a card", () => {
  assert.deepEqual(styleHits("Take a look.", { leadIn: true }), ["sign-off"])
  assert.deepEqual(styleHits("Take a look.", {}), [])
})
