import { appendFileSync } from "node:fs"
import postgres from "postgres"
import {
  client,
  removeOwner,
  stagingRefusal,
} from "../../apps/api/scripts/dev-owner.mjs"
import {
  deleteProbeUser,
  reapProbeOrgs,
  staleProbeUsers,
} from "../../qa/e2e/workos.ts"
import { CASES, callsOf, FACTS, partsOf, passed, score } from "../cos-cases.mjs"

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
 * which the guard below checks. OPENROUTER_API_KEY must be the same key as
 * staging `reme-api`'s secret of that name: the cap and the spend are read
 * from its usage. A run whose usage never moves was spending from another
 * key, so it fails rather than report a spend of zero, and so does any
 * unreadable usage. Usage lags a minute or more and other runs on the key
 * move it too, so the cap is a backstop; the api's own reservation bounds
 * each turn (ADR-034: about $0.017 at the routing cap, under $0.20 for these
 * 11 turns). Skipped without COS_API_URL, so `pnpm eval` runs everywhere.
 *
 * With E2E_DATABASE_URL set to staging's direct Neon URL, the run also reads
 * the org's `cos.turn` spend, read only, and fails unless it is within 5% of
 * what the key's usage moved (ADR-034).
 */

/** The most one run may move the key's usage. */
const SPEND_CAP_USD = 0.25

/**
 * How far the logged sum may sit from the bill: 5%, and never under a tenth
 * of a cent. Eleven turns bill a few cents, so 5% of that is less than one
 * turn, and a single stray call on the shared key would fail the run.
 */
const tolerance = (bill) => Math.max(0.05 * bill, 0.001)

/**
 * The org's CoS spend as the log holds it. Closed turns count their cost;
 * an abandoned turn lost its last step's usage, so it counts at its logged
 * spend in `low` and at the greater of that and its reservation in `high`,
 * and the bill must fall between the two. With no abandoned turn they match.
 */
export async function loggedSpend(url, orgId) {
  const sql = postgres(url, { max: 1 })
  try {
    const [row] = await sql`
      select
        coalesce(sum(case when t.payload->>'outcome' = 'abandoned'
          then (t.payload->>'logged_usd')::float8
          else (t.payload->>'cost_usd')::float8 end), 0) as low,
        coalesce(sum(case when t.payload->>'outcome' = 'abandoned'
          then greatest((t.payload->>'logged_usd')::float8,
            (t.payload->>'reserved_usd')::float8)
          else (t.payload->>'cost_usd')::float8 end), 0) as high
      from events t
      where t.org_id = ${orgId} and t.type = 'cos.turn'`
    return { low: Number(row.low), high: Number(row.high) }
  } finally {
    await sql.end()
  }
}

/**
 * Whether `bill` is within tolerance of the logged spend, and the line that
 * says so. With no logged spend, unchecked.
 */
export function billCheck(bill, logged) {
  if (!logged) {
    return {
      off: false,
      line: "E2E_DATABASE_URL is unset: the logged sum is not checked against the bill.",
    }
  }
  const { low, high } = logged
  const off = bill < low - tolerance(bill) || bill > high + tolerance(bill)
  const range =
    high > low
      ? `$${low.toFixed(4)} to $${high.toFixed(4)} with abandoned turns`
      : `$${low.toFixed(4)}`
  return {
    off,
    line: `Logged ${range}, ${off ? "not " : ""}within $${tolerance(bill).toFixed(4)} of the bill.`,
  }
}

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

/** The key's usage in dollars. Throws rather than let an unread usage pass as zero. */
async function keyUsage() {
  // Not passed through turbo: a task that saw the key would run the facade's live tests.
  // biome-ignore lint/suspicious/noUndeclaredEnvVars: not read by any turbo task
  const key = process.env.OPENROUTER_API_KEY
  if (!key) throw new Error("OPENROUTER_API_KEY is empty, so no spend is known")
  const res = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { authorization: `Bearer ${key}` },
  })
  const usage = res.ok ? (await res.json()).data?.usage : undefined
  if (typeof usage !== "number")
    throw new Error(`the key's usage could not be read (${res.status})`)
  return usage
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * What the run spent, once the key's usage shows it and stops moving, since
 * calls land in it one by one. Eleven model turns always cost something, so
 * usage that never moves means the api spends from another key.
 */
export async function spentSince(before, tries = 12) {
  let last = 0
  for (let i = 0; i < tries; i++) {
    const moved = (await keyUsage()) - before
    if (moved > 0 && moved === last) return moved
    last = moved
    await sleep(15_000)
  }
  if (last > 0) return last
  throw new Error(
    "the key's usage did not move after the run: OPENROUTER_API_KEY is not the key staging's api spends from"
  )
}

/** A JSON body, or a throw naming the route that did not answer 200. */
async function read(call, path) {
  const res = await call("GET", path)
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`)
  return res.json()
}

/**
 * Every build the org holds that someone's yes would have started: running,
 * waiting on a review, failed, published or live. The org is new, so this
 * starts at zero; only a build that was started and then cancelled within
 * the run is missed, and nothing in the run cancels one.
 */
export async function builds(call) {
  const workspace = await read(call, "/workspace")
  const activity = await read(call, "/activity")
  return {
    running: workspace.builds.map((b) => b.assignment_id),
    count:
      workspace.builds.length +
      workspace.attention.filter((a) => a.kind === "approval").length +
      (workspace.site.live ? 1 : 0) +
      activity.items.filter(
        (i) => i.what === "published" || i.reason === "build_failed"
      ).length,
  }
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
  // First, so a run with no readable spend touches nothing.
  const before = await keyUsage()
  const vars = process.env
  const refusal = await stagingRefusal({
    clientId: vars.WORKOS_CLIENT_ID,
    apiKey: vars.WORKOS_API_KEY,
  })
  if (refusal) throw new Error(refusal)
  if (!vars.WORKOS_COOKIE_PASSWORD)
    throw new Error("WORKOS_COOKIE_PASSWORD is empty")

  const workos = await client(vars)
  // What an earlier run left behind when it died before its `finally`: the
  // e2e reapers, by their prefixes and an hour's age.
  for (const id of await staleProbeUsers()) await deleteProbeUser(id)
  await reapProbeOrgs()
  const date = new Date().toISOString().slice(0, 10)
  const owner = {
    email: `qa-e2e-cos-${date}-${crypto.randomUUID().slice(0, 8)}@example.net`,
    orgName: `QA probe cleaning ${date} cos eval`,
  }
  const password = `Qa${crypto.randomUUID().replaceAll("-", "")}!`
  const run = {
    cases: [],
    builds: null,
    spentUsd: null,
    bill: null,
    stopped: null,
    // For `pnpm record`'s scan: none of these may reach a fixture.
    secrets: [owner.email, owner.orgName, new URL(base).host],
  }
  let call = null
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
    const { org_id: orgId } = await signup.json()
    // The first session predates the org and carries no org claim.
    call = api(base, await signIn())
    const stated = await call("POST", "/facts", { facts: FACTS })
    if (!stated.ok) throw new Error(`POST /facts: ${stated.status}`)
    const start = await builds(call)
    if (start.count !== 0)
      throw new Error(`the new org already holds ${start.count} build(s)`)

    for (const kase of CASES) {
      const spent = (await keyUsage()) - before
      if (spent > SPEND_CAP_USD) {
        run.stopped = `spend cap: $${spent.toFixed(4)} before ${kase.name}`
        break
      }
      run.cases.push({ name: kase.name, turns: await runCase(call, kase) })
    }
    // The run approved nothing, so every one of these is unapproved.
    run.builds = (await builds(call)).count
    run.spentUsd = await spentSince(before)
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: not read by any turbo task
    const url = process.env.E2E_DATABASE_URL
    run.bill = billCheck(
      run.spentUsd,
      url ? await loggedSpend(url, orgId) : null
    )
  } finally {
    const cleanup = []
    // No build outlives the run, even one a throw above left running.
    if (call) {
      try {
        for (const id of (await builds(call)).running) {
          const res = await call("POST", `/builds/${id}/cancel`, {})
          if (!res.ok) cleanup.push(`a build was not cancelled (${res.status})`)
        }
      } catch (error) {
        cleanup.push(`the builds were not read (${error.message})`)
      }
    }
    await removeOwner(workos, owner).catch((error) =>
      cleanup.push(`the owner was not removed (${error.name})`)
    )
    for (const line of cleanup) console.error(`      ${line}`)
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
  const green = rows.filter(passed)
  const fabrications = rows.flatMap((r) => r.fabrications)
  const tools = (r) =>
    r.turns
      .map(
        (t) =>
          callsOf(t.parts)
            .map((p) => p.toolName)
            .join("+") || "-"
      )
      .join(" / ")
  const lines = [
    "## Tier 2: Chief of Staff on staging",
    "",
    `${green.length} of ${CASES.length} cases, ${fabrications.length} fabrications, ${run.builds ?? "unknown"} unapproved builds, key usage moved $${run.spentUsd.toFixed(4)} (cap $${SPEND_CAP_USD.toFixed(2)}).`,
    run.bill.line,
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
    green.length < CASES.length &&
      `${green.length} of ${CASES.length} cases passed`,
    fabrications.length > 0 && `${fabrications.length} fabrication(s)`,
    run.builds !== 0 && `${run.builds ?? "unknown"} unapproved build(s)`,
    run.bill.off && "the logged sum is not within 5% of the bill",
  ].filter(Boolean)
  if (failures.length > 0) throw new Error(failures.join("; "))
}
