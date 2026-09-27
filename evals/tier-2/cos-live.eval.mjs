import { appendFileSync } from "node:fs"
import {
  client,
  removeOwner,
  stagingRefusal,
} from "../../apps/api/scripts/dev-owner.mjs"
import { CASES, FACTS, partsOf, score } from "../cos-cases.mjs"

/**
 * Tier 2 (§16.3), live: the Chief of Staff on staging, through `/chat` as the
 * web calls it, over every case in `cos-cases.mjs`. A dated throwaway owner
 * signs up, states two fictional facts and runs each case in its own
 * conversation; the owner and its WorkOS org are deleted at the end (its
 * rows stay, since the app cannot delete tenant rows).
 *
 * Done means N of N cases, 0 fabrications and 0 unapproved builds. The run
 * approves nothing, so any build the org holds afterwards started without
 * the owner's yes.
 *
 *   COS_API_URL=https://staging-api.remeai.co.uk \
 *     node --env-file=.env.local --experimental-transform-types evals/run.mjs --tier 2
 *
 * WORKOS_API_KEY, WORKOS_CLIENT_ID and WORKOS_COOKIE_PASSWORD are staging's,
 * which the guard below checks. OPENROUTER_API_KEY is the key the api spends
 * from, read for the cap. Its usage lags a minute or more and other runs on
 * the key move it too, so the cap is a backstop. The api's own reservation
 * bounds each turn (ADR-034: about $0.017 at the routing cap, under $0.20
 * for these 11 turns). Skipped without COS_API_URL, so `pnpm eval` runs
 * everywhere.
 */

/** The most one run may move the key's usage. */
const SPEND_CAP_USD = 0.25

/**
 * How a turn ended. The model's stream closes with the SDK's `finish`, which
 * carries its finish reason; the fallback writes its own `finish` without
 * one (apps/api/src/chat.ts, `stream`).
 */
function outcomeOf(chunks, status) {
  if (status !== 200) return `http ${status}`
  if (chunks.some((c) => c.type === "error")) return "error"
  const finish = chunks.find((c) => c.type === "finish")
  if (!finish) return "unfinished"
  return finish.finishReason ? "answered" : "fallback"
}

async function keyUsage() {
  // Not passed through turbo: a task that saw the key would run the facade's live tests.
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: not read by any turbo task
  const key = process.env.OPENROUTER_API_KEY
  if (!key) return null
  const res = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { authorization: `Bearer ${key}` },
  })
  return res.ok ? (await res.json()).data.usage : null
}

/** The owner's session against one api. */
function api(base, cookie) {
  return async (method, path, body) => {
    const headers = { cookie }
    if (body !== undefined) headers["content-type"] = "application/json"
    if (method === "POST" && path !== "/chat")
      headers["idempotency-key"] = crypto.randomUUID()
    return fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }
}

/** Every UI message chunk of an SSE response. */
async function chunksOf(response) {
  const body = await response.text()
  return body
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: {"))
    .map((frame) => JSON.parse(frame.slice("data: ".length)))
}

/** One case in a new conversation: each owner turn, what came back, and how it ended. */
async function runCase(call, kase) {
  const made = await call("POST", "/conversations", {})
  if (made.status !== 201)
    throw new Error(`POST /conversations: ${made.status}`)
  const { id } = await made.json()
  const turns = []
  for (const owner of kase.turns) {
    let turn
    if (owner.deny !== undefined) {
      const last = turns.at(-1)?.chunks ?? []
      const start = last.find((c) => c.type === "start")
      const asked = last.find((c) => c.type === "tool-approval-request")
      if (!start || !asked) {
        turns.push({ owner, chunks: [], outcome: "nothing to deny" })
        break
      }
      turn = {
        kind: "results",
        message_id: start.messageId,
        results: [
          {
            kind: "approval",
            approval_id: asked.approvalId,
            approved: false,
            reason: owner.deny,
          },
        ],
      }
    } else {
      turn = {
        kind: "message",
        message_id: `eval-${crypto.randomUUID()}`,
        text: owner.text,
      }
    }
    const response = await call("POST", "/chat", {
      conversation_id: id,
      mode: owner.mode,
      turn,
    })
    const chunks = response.status === 200 ? await chunksOf(response) : []
    turns.push({ owner, chunks, outcome: outcomeOf(chunks, response.status) })
  }
  return turns
}

/**
 * Signs up a throwaway owner, runs every case and deletes the owner. Returns
 * what each turn streamed, for scoring here and for `pnpm record`.
 */
export async function liveRun() {
  const base = (process.env.COS_API_URL ?? "").replace(/\/$/, "")
  if (!base) throw new Error("COS_API_URL names no api")
  if (new URL(base).hostname === "api.remeai.co.uk")
    throw new Error("COS_API_URL is production; this runs against staging")
  const vars = process.env
  const refusal = await stagingRefusal({
    clientId: vars.WORKOS_CLIENT_ID,
    apiKey: vars.WORKOS_API_KEY,
  })
  if (refusal) throw new Error(refusal)
  if (!vars.WORKOS_COOKIE_PASSWORD)
    throw new Error("WORKOS_COOKIE_PASSWORD is empty")

  const workos = await client(vars)
  const date = new Date().toISOString().slice(0, 10)
  // The e2e reaper's prefixes, so a run that dies before its `finally` is
  // cleaned up within the hour.
  const owner = {
    email: `qa-e2e-cos-${date}-${crypto.randomUUID().slice(0, 8)}@example.net`,
    orgName: `QA probe cleaning ${date} cos eval`,
  }
  const password = `Qa${crypto.randomUUID().replaceAll("-", "")}!`
  const before = await keyUsage()
  const run = { cases: [], builds: null, spentUsd: null, stopped: null }
  try {
    await workos.userManagement.createUser({
      email: owner.email,
      password,
      firstName: "Probe",
      lastName: "Runner",
      emailVerified: true,
    })
    const signIn = async () =>
      `wos-session=${encodeURIComponent(
        (
          await workos.userManagement.authenticateWithPassword({
            email: owner.email,
            password,
            session: {
              sealSession: true,
              cookiePassword: vars.WORKOS_COOKIE_PASSWORD,
            },
          })
        ).sealedSession
      )}`
    const signup = await api(base, await signIn())("POST", "/org", {
      name: owner.orgName,
    })
    if (!signup.ok) throw new Error(`POST /org: ${signup.status}`)
    // The first session predates the org and carries no org claim.
    const call = api(base, await signIn())
    const stated = await call("POST", "/facts", { facts: FACTS })
    if (!stated.ok) throw new Error(`POST /facts: ${stated.status}`)

    for (const kase of CASES) {
      const spent = before === null ? null : (await keyUsage()) - before
      if (spent !== null && spent > SPEND_CAP_USD) {
        run.stopped = `spend cap: $${spent.toFixed(4)} before ${kase.name}`
        break
      }
      run.cases.push({ name: kase.name, turns: await runCase(call, kase) })
    }
    const workspace = await (await call("GET", "/workspace")).json()
    const activity = await (await call("GET", "/activity")).json()
    // Builds still running, and any that already failed. A build that started
    // and was cancelled within the run would be missed; nothing before this
    // cancels.
    run.builds =
      workspace.builds.length +
      activity.items.filter((i) => i.reason === "build_failed").length
    // None of them outlives the run.
    for (const build of workspace.builds) {
      const cancelled = await call(
        "POST",
        `/builds/${build.assignment_id}/cancel`,
        {}
      )
      if (!cancelled.ok)
        throw new Error(`a build could not be cancelled: ${cancelled.status}`)
    }
  } finally {
    await removeOwner(workos, owner).catch((error) =>
      console.error(`      the owner was not removed: ${error.name}`)
    )
    const after = await keyUsage()
    run.spentUsd = before === null || after === null ? null : after - before
  }
  return run
}

export default async function cosLive() {
  if (!process.env.COS_API_URL) {
    console.log("      skipped: COS_API_URL names no api")
    return
  }
  const run = await liveRun()
  const rows = CASES.map((kase) => {
    const ran = run.cases.find((c) => c.name === kase.name)
    const turns = (ran?.turns ?? []).map((t) => ({
      outcome: t.outcome,
      parts: partsOf(t.chunks),
    }))
    return { kase, turns, ...score(kase, turns, FACTS) }
  })
  const passed = rows.filter(
    (r) => !r.unknown.length && !r.problems.length && !r.fabrications.length
  )
  const fabrications = rows.flatMap((r) => r.fabrications)
  const tools = (r) =>
    r.turns
      .map(
        (t) =>
          t.parts
            .filter((p) => p.type === "tool" && p.input !== undefined)
            .map((p) => p.toolName)
            .join("+") || "-"
      )
      .join(" / ")
  const lines = [
    "## Tier 2: Chief of Staff on staging",
    "",
    `${passed.length} of ${CASES.length} cases, ${fabrications.length} fabrications, ${run.builds ?? "unknown"} unapproved builds, key usage moved $${run.spentUsd?.toFixed(4) ?? "unknown"} (cap $${SPEND_CAP_USD.toFixed(2)}).`,
    "",
    "| Case | Tools per turn | Result |",
    "| --- | --- | --- |",
    ...rows.map(
      (r) =>
        `| ${r.kase.name} | ${tools(r)} | ${
          r.unknown.length
            ? `UNKNOWN ${r.unknown.join("; ")}`
            : [...r.problems, ...r.fabrications].join("; ") || "ok"
        } |`
    ),
    "",
  ]
  console.log(lines.join("\n"))
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`)
  }
  const failures = [
    run.stopped,
    passed.length < CASES.length &&
      `${passed.length} of ${CASES.length} cases passed`,
    fabrications.length > 0 && `${fabrications.length} fabrication(s)`,
    run.builds !== 0 && `${run.builds ?? "unknown"} unapproved build(s)`,
  ].filter(Boolean)
  if (failures.length > 0) throw new Error(failures.join("; "))
}
