import assert from "node:assert/strict"
import { test } from "node:test"
import { fidelity } from "./fidelity.mjs"

const brief = {
  edit_type: "add_section",
  targets: [{ page: "about" }],
  acceptance: ["a", "b"],
}
const story = "We started in 2019 with one van."
const passing = [
  { check: "a", passed: true, why: "seen" },
  { check: "b", passed: true, why: "seen" },
]

test("a change whose checks hold, on its target, with the owner's words as given, passes", () => {
  assert.deepEqual(
    fidelity({
      brief,
      checks: passing,
      blocks: [{ page: "about", section: "story" }],
      pages: {
        "/about/": "<h2>Our story</h2><p>We started in 2019  with one van.</p>",
      },
      verbatim: story,
    }),
    { passed: true, problems: [] }
  )
  assert.deepEqual(
    fidelity({
      brief,
      checks: passing,
      pages: { "/about/": "<p>Since 2019 we have grown.</p>" },
      verbatim: story,
    }).problems,
    ["the owner's words are not on the page as given"]
  )
})

test("a missed check, a change off target and a change nothing judged fail", () => {
  assert.deepEqual(
    fidelity({
      brief,
      checks: [{ check: "a", passed: false, why: "no heading" }],
      blocks: [{ page: "about" }, { page: "home" }],
    }).problems,
    ["check failed: a (no heading)", "changed off target: home"]
  )
  assert.deepEqual(fidelity({ brief }).problems, [
    "no acceptance check was judged",
  ])
  assert.equal(
    fidelity({
      brief,
      checks: passing,
      blocks: [{ page: "home" }],
      also: ["home"],
    }).passed,
    true
  )
})
