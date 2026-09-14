// The builder console, from a terminal: `pnpm builder <command> ...`.
//
// Talks to apps/orchestrator over HTTP with the bearer in ORCHESTRATOR_TOKEN,
// at ORCHESTRATOR_URL (default: the local dev server). Every command is one
// request and prints what came back, so a person can drive a build by hand
// and read the same stream the model will see. Commands whose routes have not
// landed yet print the orchestrator's 501, which names the story.
//
//   create   <org> [--kind site.build|site.revise] [--model A|B] [--goal "..."]
//   revise   <org> <change request>          a site.revise with that goal
//   list     <org>
//   show     <org> <id>
//   events   <org> <id>                      the stream, with seq
//   start    <org> <id>                      run a queued assignment that has no instance
//   cancel   <org> <id>
//   answer   <org> <id> <request_id> <value> answer an information request as the CoS would
//   steer    <org> <id> <message>            join the running conversation at the next turn
//   approve  <org> <id> <revision_id>        approve as the owner would
//   rollback <org>                           activate the previous revision
import { bad, loadLocalEnv, note, repoRoot } from "./lib.mjs"

process.chdir(repoRoot)
loadLocalEnv()

const base = (process.env.ORCHESTRATOR_URL ?? "http://localhost:3002").replace(
  /\/$/,
  ""
)
const token = process.env.ORCHESTRATOR_TOKEN ?? ""

const [command, ...rest] = process.argv.slice(2)
const flags = {}
const positional = []
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i]
  if (arg.startsWith("--")) {
    flags[arg.slice(2)] = rest[i + 1]
    i++
  } else {
    positional.push(arg)
  }
}
const [org, id, ...more] = positional

async function call(method, path, body) {
  const url = new URL(`${base}${path}`)
  url.searchParams.set("org", org ?? "")
  // No token, no header: the orchestrator's answer to a missing bearer is
  // the 401 a person should see, not a 400 for a malformed one.
  const headers = token ? { authorization: `Bearer ${token}` } : {}
  if (body) headers["content-type"] = "application/json"
  if (method === "POST") headers["idempotency-key"] = crypto.randomUUID()
  let res
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch (error) {
    bad(`${base} did not answer: ${error.message}`)
    note("Start it with: pnpm --filter orchestrator dev")
    process.exit(1)
  }
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    // The §28.1 envelope, as the orchestrator wrote it.
    bad(`${res.status} ${json.class ?? ""} ${json.code ?? ""}`)
    note(json.message ?? "")
    if (json.detail && Object.keys(json.detail).length > 0) {
      note(JSON.stringify(json.detail))
    }
    process.exit(1)
  }
  return json
}

const need = (value, what) => {
  if (!value) {
    bad(`missing ${what}`)
    process.exit(2)
  }
  return value
}

const print = (value) => console.log(JSON.stringify(value, null, 2))

switch (command) {
  case "create": {
    need(org, "<org>")
    print(
      await call("POST", "/assignments", {
        kind: flags.kind ?? "site.build",
        model: flags.model ?? "A",
        goal: flags.goal,
      })
    )
    break
  }
  case "revise": {
    need(org, "<org>")
    const goal = need(
      [id, ...more].filter(Boolean).join(" "),
      "<change request>"
    )
    print(
      await call("POST", "/assignments", {
        kind: "site.revise",
        model: flags.model ?? "A",
        goal,
      })
    )
    break
  }
  case "list": {
    need(org, "<org>")
    const { assignments } = await call("GET", "/assignments")
    for (const a of assignments) {
      console.log(
        `${a.assignment_id}  ${a.state.padEnd(22)} v${a.expected_version}  ${a.kind}`
      )
    }
    break
  }
  case "show": {
    need(org, "<org>")
    need(id, "<id>")
    print(await call("GET", `/assignments/${id}`))
    break
  }
  case "events": {
    need(org, "<org>")
    need(id, "<id>")
    const { events } = await call("GET", `/assignments/${id}/events`)
    for (const e of events) {
      const seq = e.seq === null ? "-" : String(e.seq)
      console.log(`${e.event_id}  seq=${seq.padEnd(4)} ${e.type}`)
      console.log(`    ${JSON.stringify(e.payload)}`)
    }
    break
  }
  case "start":
  case "cancel": {
    need(org, "<org>")
    need(id, "<id>")
    print(await call("POST", `/assignments/${id}/${command}`, {}))
    break
  }
  case "answer": {
    need(org, "<org>")
    need(id, "<id>")
    const [requestId, ...value] = more
    need(requestId, "<request_id>")
    print(
      await call("POST", `/assignments/${id}/answer`, {
        request_id: requestId,
        value: need(value.join(" "), "<value>"),
      })
    )
    break
  }
  case "steer": {
    need(org, "<org>")
    need(id, "<id>")
    print(
      await call("POST", `/assignments/${id}/steer`, {
        message: need(more.join(" "), "<message>"),
      })
    )
    break
  }
  case "approve": {
    need(org, "<org>")
    need(id, "<id>")
    print(
      await call("POST", `/assignments/${id}/approve`, {
        revision_id: need(more[0], "<revision_id>"),
      })
    )
    break
  }
  case "rollback": {
    need(org, "<org>")
    print(await call("POST", "/assignments/rollback", {}))
    break
  }
  default: {
    bad(command ? `unknown command: ${command}` : "no command")
    note(
      "create | revise | list | show | events | start | cancel | answer | steer | approve | rollback"
    )
    process.exit(2)
  }
}
