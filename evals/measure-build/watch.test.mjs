import assert from "node:assert/strict"
import { test } from "node:test"
import { awaitingRound } from "./watch.mjs"

const proposed = (round, review) => ({
  type: "blueprint.proposed",
  payload: { round, review },
})
const decided = (round) => ({ type: "blueprint.decided", payload: { round } })

test("a reviewed plan with no decision waits on its round", () => {
  assert.equal(awaitingRound([proposed(1, true)]), 1)
})

test("a decided round, a skipped review or no plan does not wait", () => {
  assert.equal(awaitingRound([proposed(1, true), decided(1)]), null)
  assert.equal(awaitingRound([proposed(1, false)]), null)
  assert.equal(awaitingRound([]), null)
})

test("a re-plan waits again even though the earlier round was decided", () => {
  assert.equal(
    awaitingRound([proposed(1, true), decided(1), proposed(2, true)]),
    2
  )
})
