import assert from "node:assert/strict"
import { test } from "node:test"
import { check, verdict } from "./voice.mjs"

const sample = (text, named = true) => ({ id: "t", source: "cos", text, named })

test("a clean line has no hit and a planted dash is a hard hit", () => {
  const [clean, dash] = check([
    sample("Your website is live at spark.example."),
    sample("Your website is live — have a look."),
  ])
  assert.deepEqual([clean.hard, clean.soft], [[], []])
  assert.equal(dash.hard.length, 1)
})

test("an id is hard, a chatbot opener is soft, Reme is hard only once the assistant is named", () => {
  const [id, opener, named, unnamed] = check([
    sample("Build ead99cb0 is ready."),
    sample("Great question. It is Tuesday."),
    sample("Reme will do it."),
    sample("Reme will do it.", false),
  ])
  assert.equal(id.hard.length, 1)
  assert.equal(opener.soft.length, 1)
  assert.equal(named.hard.length, 1)
  assert.equal(unnamed.hard.length, 0)
})

test("the bar: a hard hit fails, three soft hits fail, two pass, a weak judge fails", () => {
  const soft = (n) =>
    check(Array.from({ length: n }, () => sample("Great question.")))
  assert.equal(verdict(check([sample("a — b")])).pass, false)
  assert.equal(verdict(soft(2)).pass, true)
  assert.equal(verdict(soft(3)).pass, false)
  const clean = check([sample("Done.")])
  assert.equal(verdict(clean, [{ score: 5 }]).pass, true)
  assert.equal(verdict(clean, [{ score: 3 }]).pass, false)
})
