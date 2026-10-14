import assert from "node:assert/strict"
import { test } from "node:test"
import { batchClient } from "../../apps/api/src/cos/batch.ts"
import { RULES, TELLS } from "../../packages/gates/src/rubric.ts"
import {
  cssLinks,
  HTML_MAX,
  report,
  requestsFor,
  rubricPrompt,
  scoreBatch,
  slim,
  verdictSchema,
} from "./score.mjs"

const verdict = ({ failRules = [], tells = [], skip } = {}) => ({
  rules: RULES.filter((r) => r.id !== skip).map((r) => ({
    id: r.id,
    pass: !failRules.includes(r.id),
    node: failRules.includes(r.id) ? `<h2> in ${r.id}` : null,
  })),
  tells: TELLS.map((t) => ({
    id: t.id,
    present: tells.includes(t.id),
    node: tells.includes(t.id) ? "the hero" : null,
  })),
})

/** OpenRouter, stood in for: queues what it is sent, then answers with the scripted reply per custom_id. */
function openrouter(replies) {
  const sent = []
  let queued
  const fetch = async (_url, init) => {
    if (init?.method === "POST") {
      queued = JSON.parse(init.body)
      sent.push(queued)
      return new Response(
        JSON.stringify({ id: "batch_1", status: "validating", results: null }),
        { status: 202 }
      )
    }
    return new Response(
      JSON.stringify({
        id: "batch_1",
        status: "completed",
        results: queued.requests
          .filter((r) => replies[r.custom_id] !== undefined)
          .map((r) => ({
            custom_id: r.custom_id,
            response: {
              status_code: 200,
              body: {
                choices: [{ message: { content: replies[r.custom_id] } }],
              },
            },
            error: null,
          })),
      }),
      { status: 200 }
    )
  }
  return { fetch, sent }
}

const build = (id, extra = {}) => ({
  id,
  html: "<html><body><h1>Spotless homes, every week</h1></body></html>",
  css: "body { color: black }",
  ...extra,
})

test("the prompt lists the rubric's own rules and tells, once each", () => {
  const { system } = rubricPrompt(build("a"))
  for (const item of [...RULES, ...TELLS]) {
    assert.equal(system.split(`- ${item.id}:`).length, 2, item.id)
  }
})

test("the verdict schema accepts exactly the rubric's ids", () => {
  const { schema } = verdictSchema()
  assert.deepEqual(
    schema.properties.rules.items.properties.id.enum,
    RULES.map((r) => r.id)
  )
  assert.deepEqual(
    schema.properties.tells.items.properties.id.enum,
    TELLS.map((t) => t.id)
  )
})

test("a page is shown without scripts, drawn paths and inlined binaries, and bounded", () => {
  const html = `<script>alert(1)</script><svg><path d="M0 0"/></svg><img src="data:image/png;base64,AAAA"> ${"x".repeat(HTML_MAX)}`
  const out = slim(html)
  assert.ok(!out.includes("alert"))
  assert.ok(!out.includes("M0 0"))
  assert.ok(!out.includes("AAAA"))
  assert.equal(out.length, HTML_MAX)
  assert.deepEqual(
    cssLinks(
      '<link rel="stylesheet" href="/_astro/index.abc.css"><link href="/f.ico">'
    ),
    ["/_astro/index.abc.css"]
  )
})

test("one request per build on the one model, the schema strict and requests last", async () => {
  const replies = {}
  const { fetch, sent } = openrouter(replies)
  await batchClient({ apiKey: "k", fetch }).submit({
    model: "anthropic/claude-sonnet-5.5:batch",
    requests: requestsFor([build("a"), build("b")]),
  })
  const body = sent[0]
  assert.deepEqual(Object.keys(body), ["endpoint", "model", "requests"])
  assert.equal(body.model, "anthropic/claude-sonnet-5.5")
  assert.deepEqual(
    body.requests.map((r) => r.custom_id),
    ["a", "b"]
  )
  const first = body.requests[0].body
  assert.equal(first.model, "anthropic/claude-sonnet-5.5")
  assert.equal(first.response_format.json_schema.strict, true)
  assert.match(first.messages[1].content, /Spotless homes/)
})

test("a sweep scores each build and reports pass or fail per rule and the tells", async () => {
  const { fetch } = openrouter({
    clean: JSON.stringify(verdict()),
    slop: JSON.stringify(
      verdict({
        failRules: ["eyebrow", "brevity"],
        tells: ["generic_headings", "centred"],
      })
    ),
    // A critic that skipped a rule is not read as passing it.
    skipped: JSON.stringify(verdict({ skip: "fonts" })),
    prose: "Looks lovely to me.",
    // "gone" gets no result at all.
  })
  const client = batchClient({ apiKey: "k", fetch })
  const ids = ["clean", "slop", "skipped", "prose", "gone"]
  const batch = await client.submit({
    model: "anthropic/claude-sonnet-5.5",
    requests: requestsFor(ids.map((id) => build(id))),
  })
  const done = await client.wait(batch.id, { everyMs: 1 })
  const scored = scoreBatch(done, ids)
  const by = Object.fromEntries(scored.map((s) => [s.id, s]))

  assert.equal(by.clean.score, 100)
  assert.equal(by.clean.passed, true)
  assert.equal(by.slop.score, Math.round((18 / 22) * 100))
  assert.equal(by.slop.passed, false)
  assert.ok(by.skipped.problems.includes("rule fonts was not answered"))
  assert.equal(by.skipped.passed, false)
  assert.match(by.prose.error, /no JSON object/)
  assert.match(by.gone.error, /no result/)

  const text = report(scored)
  assert.match(text, /== clean {2}score 100 {2}rules 12\/12/)
  assert.match(text, /pass fonts/)
  assert.match(text, /FAIL eyebrow {2}<h2> in eyebrow/)
  assert.match(text, /FAIL brevity/)
  assert.match(text, /pass hairlines/)
  assert.match(text, /slop tells: none/)
  assert.match(
    text,
    /slop tells: centred \(the hero\); generic_headings \(the hero\)/
  )
  assert.match(text, /== prose {2}NOT SCORED: the reply holds no JSON object/)
  assert.match(text, /3 scored, 2 not; mean/)
})
