import assert from "node:assert/strict"
import { test } from "node:test"
import { checkProblems, fidelity } from "./fidelity.mjs"

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

test("a check the judge could not decide neither passes nor fails the change, wherever it is scored", () => {
  const unknown = { check: "b", passed: null, why: "no page given" }
  assert.deepEqual(checkProblems([passing[0], unknown]), [])
  assert.deepEqual(fidelity({ brief, checks: [passing[0], unknown] }), {
    passed: true,
    problems: [],
  })
  assert.deepEqual(checkProblems([unknown, { ...unknown, check: "c" }]), [
    "no acceptance check could be decided",
  ])
  assert.deepEqual(
    checkProblems([{ check: "a", passed: false, why: "no tel link" }, unknown]),
    ["check failed: a (no tel link)"]
  )
})
