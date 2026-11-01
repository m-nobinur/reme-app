import assert from "node:assert/strict"
import { test } from "node:test"
import { claimOf, filesFor } from "./local-sites.mjs"

const STORY =
  "We started in 2019 with one van and a list of three regular homes. Five years on, the same two of us still check every job before we leave."
const NEW_PHONE = "+441174960999"
const PUBLISHED = "measure-clean-01-stg.example.test"

const HOME = `<a href="/services/deep-clean/">Deep clean</a><a href="/services/end-of-tenancy/">End of tenancy</a><a href="/services/oven-clean/">Oven clean</a><h2>Services</h2><h2>Questions</h2>`
const PREVIEW_PAGE = `<h2>Services</h2><h2>Questions</h2><p>Our story</p><p>${STORY}</p><a href="tel:${NEW_PHONE}">call</a>`

/** A measure-build org as the console shows it: offerings are strings, the phone is {e164}, no site.content. */
function orchestrator({ failOn, flaky } = {}) {
  const log = []
  const facts = {
    "business.offerings": {
      items: ["Deep clean", "End of tenancy clean", "Oven clean"],
    },
    "business.phone": { e164: "+12065550100" },
  }
  let made = 0
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status })
  const fetch = async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" ? input : (input.href ?? input.url)
    )
    const method = init.method ?? "GET"
    const body = init.body ? JSON.parse(init.body) : undefined
    if (url.host === PUBLISHED) return new Response(HOME)
    if (url.host.endsWith(".preview.test")) {
      if (url.pathname === "/sitemap.xml")
        return new Response(
          `<loc>https://${url.host}/</loc><loc>https://${url.host}/about/</loc>`
        )
      return new Response(PREVIEW_PAGE)
    }
    assert.equal(url.searchParams.get("org"), "measure-clean-01")
    const path = url.pathname.replace("/assignments", "") || "/"
    log.push([method, path, body, init.headers?.["idempotency-key"]])
    if (flaky && flaky.path === path && flaky.left-- > 0)
      return json({ code: "dev.dropped" }, 500)
    if (method === "GET" && path === "/site")
      return json({ host: PUBLISHED, active: { revision_id: "rev-0" } })
    if (method === "GET" && path === "/facts")
      return json({
        facts: Object.entries(facts).map(([key, value]) => ({ key, value })),
      })
    if (method === "POST" && path === "/facts") {
      for (const f of body.facts) facts[f.key] = f.value
      return json({ facts: body.facts }, 201)
    }
    if (method === "POST" && path === "/") {
      if (failOn && body.goal === failOn) throw new Error("connection reset")
      return json({ assignment_id: `a${++made}`, state: "preview_ready" }, 201)
    }
    const id = /^\/(a\d+)/.exec(path)?.[1]
    if (path.endsWith("/events"))
      return json({
        events: [
          {
            type: "change.checked",
            payload: {
              checks: [
                { check: "one", passed: true, why: "seen" },
                { check: "two", passed: null, why: "no page given" },
              ],
            },
          },
          {
            type: "assignment.completion_reported",
            payload: { revision_id: `rev-${id}`, blocks: [] },
          },
        ],
      })
    if (path.endsWith("/preview"))
      return json({ url: `https://${id}.preview.test/open?t=x` })
    if (method === "POST") return json({})
    return json({ assignment: { state: "preview_ready" } })
  }
  return { fetch, log, facts }
}

async function run(options) {
  process.env.ORCHESTRATOR_URL = "http://orchestrator.test"
  process.env.ORCHESTRATOR_TOKEN = "token"
  process.env.FIDELITY_ORG = "measure-clean-01"
  const realFetch = globalThis.fetch
  const realLog = console.log
  const server = orchestrator(options)
  const printed = []
  globalThis.fetch = server.fetch
  console.log = (line) => printed.push(line)
  let error
  try {
    const { default: changeFidelity } = await import(
      `./change-fidelity.eval.mjs?${Math.random()}`
    )
    await changeFidelity()
  } catch (thrown) {
    error = thrown
  } finally {
    globalThis.fetch = realFetch
    console.log = realLog
  }
  return { ...server, table: printed.join("\n"), error }
}

test("a measure-build org runs the eval: string offerings, an {e164} phone, no site.content", async () => {
  const { table, error, log, facts } = await run()
  assert.equal(error, undefined, table)
  assert.match(
    table,
    /\| a story survives a redesign word for word \|.*skipped: measure-clean-01 holds no site\.content fact/
  )
  assert.match(table, /\| a new phone reaches every page \|.*\| ok \|/)
  assert.match(
    table,
    /\| a removed service leaves every place it showed \|.*\| ok \|/
  )
  assert.deepEqual(facts["business.phone"], { e164: "+12065550100" })
  assert.deepEqual(facts["business.offerings"].items, [
    "Deep clean",
    "End of tenancy clean",
    "Oven clean",
  ])
  const removed = log.find(
    ([method, path, body]) =>
      method === "POST" &&
      path === "/facts" &&
      body.facts[0].key === "business.offerings"
  )
  assert.deepEqual(removed[2].facts[0].value.items, [
    "Deep clean",
    "End of tenancy clean",
  ])
  assert.ok(
    log.some(
      ([method, path, body]) =>
        method === "POST" &&
        path === "/facts" &&
        body.facts[0].value.e164 === NEW_PHONE
    )
  )
})

test("a request answered 5xx is sent once more under the same idempotency key", async () => {
  const { table, error, log } = await run({
    flaky: { path: "/", left: 1 },
  })
  assert.equal(error, undefined, table)
  const creates = log.filter(
    ([method, path]) => method === "POST" && path === "/"
  )
  assert.equal(creates[0][3], creates[1][3])
  assert.notEqual(creates[1][3], creates[2][3])
  assert.doesNotMatch(table, /FAILED/)
})

test("a request that keeps failing fails only its own row", async () => {
  const { table, error } = await run({ flaky: { path: "/", left: 2 } })
  assert.match(table, /\| add our story to About \|.*FAILED threw: 500/)
  assert.match(table, /\| make the deep clean page richer \|.*\| ok \|/)
  assert.match(error.message, /add our story to About: threw: 500/)
})

test("an undo is requested for review before it starts, from the moved draft", async () => {
  const { log } = await run()
  const review = log.findIndex(([, path]) => path.endsWith("/review"))
  const undo = log.findIndex(
    ([, , body]) => body?.goal === "Undo the last change"
  )
  assert.ok(review > -1 && undo > review, JSON.stringify({ review, undo }))
  const moved = log[review][1].split("/")[1]
  assert.equal(log[undo][2].draft_revision_id, `rev-${moved}`)
})

test("a judge's undecided check passes the row; one request that throws fails only its own row", async () => {
  const { table, error } = await run({
    failOn: "Put the phone number in the header",
  })
  assert.match(
    table,
    /\| put the phone number in the header \|.*\| FAILED threw: connection reset \|/
  )
  assert.match(
    table,
    /\| add our story to About \|.*\| 1\/2 \(1 undecided\) \|.*\| ok \|/
  )
  assert.match(table, /\| undo puts the page back \|.*\| ok \|/)
  assert.match(error.message, /put the phone number in the header: threw/)
})

test("a preview token names its revision, and a site path names its built file", () => {
  const token = `${Buffer.from(JSON.stringify({ revision_id: "r1" })).toString("base64url")}.sig`
  assert.equal(claimOf(token).revision_id, "r1")
  assert.deepEqual(filesFor("/"), ["index.html"])
  assert.deepEqual(filesFor("/about/"), ["about/index.html"])
  assert.deepEqual(filesFor("/sitemap.xml"), [
    "sitemap.xml",
    "sitemap.xml/index.html",
  ])
})
