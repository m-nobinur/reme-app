import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { clearOrgs } from "../packages/db/fixtures/seed.ts"
import { connect } from "../packages/db/src/client.ts"
import { facts, memberships, orgs, users } from "../packages/db/src/schema.ts"
import { ensureStartingTeam, rootStaffId } from "../packages/db/src/staff.ts"
import { ENTER_APP_ROLE, setContext } from "../packages/db/src/tenancy.ts"
import { awaitingRound, SETTLED } from "./measure-build/watch.mjs"
import { BUSINESSES, toFacts, toTray } from "./variety/businesses.mjs"

/**
 * One measured build on local servers, for the creative builder's final pass:
 *
 *   node --experimental-transform-types --no-warnings evals/measure-build.mjs
 *        --business clean-05 --out DIR [--state R2_STATE_DIR] [--edits 1]
 *
 * Seeds one org for one EV1 business into the local DB (clears it first, so
 * a rerun starts clean) with the starting team, Developer included; puts
 * three stand-in owner photos in local R2 when the business has uploads
 * (drawn once on Nano Banana, kept in DIR/photos); starts a build through the
 * orchestrator on ORCHESTRATOR_URL; answers "Build it" if the build waits on
 * its Blueprint; watches to `preview_ready` or a settled state and saves the
 * events. Never approves. With `--edits 1` it then runs the five canned quick
 * edits on that site, one after another. A revise needs a served revision, so
 * before each edit the driver records a `rollback`-kind deployments row for
 * the latest preview in the local DB only: no approval, no KV, no publish.
 *
 * Spend: stops (cancelling the open assignment) once the OpenRouter key's
 * usage has risen by SPEND_STOP_USD since the start; key usage can include
 * other callers, so it is an upper bound on this run's own cost events.
 */

const SPEND_STOP_USD = 8
const BUILD_TIMEOUT_MS = 30 * 60_000
const EDIT_TIMEOUT_MS = 8 * 60_000

/** QE1's five canned edits. `facts` change first, as the CoS would. */
const EDITS = [
  {
    name: "hero-title",
    change_kind: "copy",
    goal: "Change the hero title to: Come home to a calmer house.",
  },
  {
    name: "phone",
    change_kind: "copy",
    facts: [{ key: "business.phone", value: { e164: "+12065550188" } }],
    goal: "Our phone number is now (206) 555-0188. Update it everywhere on the site.",
  },
  {
    name: "colour",
    change_kind: "style",
    goal: "Make the main colour a deeper, darker green.",
  },
  {
    name: "photo-redraw",
    change_kind: "photo",
    goal: "Try another hero photo.",
  },
  {
    name: "section-rewrite",
    change_kind: "section",
    goal: "Rewrite the how-it-works section in shorter, warmer words. Keep every step and every fact as it is.",
  },
]

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .flatMap((a, i, all) => (i % 2 ? [] : [[a.replace(/^--/, ""), all[i + 1]]]))
)
const business = BUSINESSES.find((b) => b.id === (args.business ?? "clean-05"))
if (!business) throw new Error(`no business ${args.business}`)
const out = args.out ?? "measure-out"
const state =
  args.state ?? "../cb-integration/apps/orchestrator/.wrangler/state"
const base = (process.env.ORCHESTRATOR_URL ?? "http://localhost:3002").replace(
  /\/$/,
  ""
)
const token = process.env.ORCHESTRATOR_TOKEN ?? ""
// biome-ignore lint/suspicious/noUndeclaredEnvVars: a turbo pass-through would make the facade live tests run
const openrouter = process.env.OPENROUTER_API_KEY ?? ""
if (!token || !openrouter)
  throw new Error("ORCHESTRATOR_TOKEN and OPENROUTER_API_KEY are required")

const number = Number(business.id.replace(/\D/g, ""))
const ORG_ID = `5ea5e000-0000-4000-8000-${String(number).padStart(12, "0")}`
const USER_ID = `5ea5e000-0000-4000-8001-${String(number).padStart(12, "0")}`
const SLUG = `measure-${business.id}`
mkdirSync(out, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (line) => console.log(`${new Date().toISOString()} ${line}`)

async function keyUsage() {
  const res = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { authorization: `Bearer ${openrouter}` },
  })
  return (await res.json()).data.usage
}

async function call(method, path, body) {
  const url = new URL(`${base}/assignments${path}`)
  url.searchParams.set("org", SLUG)
  const headers = { authorization: `Bearer ${token}` }
  if (body) headers["content-type"] = "application/json"
  if (method === "POST") headers["idempotency-key"] = crypto.randomUUID()
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok)
    throw new Error(
      `${res.status} ${json.code ?? ""} on ${method} ${path}: ${json.message ?? ""}`
    )
  return json
}

/** The org, its owner and team, and the business's facts, from nothing. */
async function seed() {
  const { sql: client, db } = connect()
  try {
    await db.transaction(async (tx) => {
      await clearOrgs(tx, [ORG_ID], [USER_ID])
      await tx
        .insert(orgs)
        .values({ id: ORG_ID, slug: SLUG, name: `${business.name} (measure)` })
      await tx.insert(users).values({
        id: USER_ID,
        workosUserId: `user_measure_${business.id}`,
        email: `owner@${SLUG}.invalid`,
        name: "Measure Owner",
      })
      await tx.insert(memberships).values({
        orgId: ORG_ID,
        userId: USER_ID,
        workosMembershipId: `om_measure_${business.id}`,
        role: "owner",
        status: "active",
      })
    })
    // The team and the facts go in as the tenant, the way `withOrg` writes:
    // `ensureStartingTeam` reads the org's root through the RLS policies.
    const [root] = await db.transaction(async (tx) => {
      await tx.execute(ENTER_APP_ROLE)
      await tx.execute(setContext({ orgId: ORG_ID }))
      await ensureStartingTeam(tx, {
        orgId: ORG_ID,
        userId: USER_ID,
        ownerName: "Measure Owner",
      })
      return [{ id: await rootStaffId(tx) }]
    })
    const now = new Date()
    await db.transaction(async (tx) => {
      await tx.execute(ENTER_APP_ROLE)
      await tx.execute(setContext({ orgId: ORG_ID }))
      await tx.insert(facts).values(
        toFacts(business).map(({ key, value }) => ({
          orgId: ORG_ID,
          key,
          factType: key.split(".")[0],
          value,
          provenanceSource: "owner_stated",
          provenanceConfidence: 1,
          verifiedByStaffId: root.id,
          verifiedAt: now,
          validFrom: now,
        }))
      )
    })
  } finally {
    await client.end()
  }
  log(`seeded ${SLUG} (${ORG_ID})`)
}

const PHOTO_SUBJECTS = [
  "a freshly cleaned bright kitchen with clear worktops, morning light",
  "a tidy sunlit living room with a folded throw on the sofa",
  "a cleaner's caddy of supplies on a clean hallway floor, seen from above",
]

/** Three owner photos in local R2, drawn once and reused from disk. */
async function placeUploads() {
  const items =
    toFacts(business).find((f) => f.key === "media.uploads")?.value.items ?? []
  const dir = join(out, "photos")
  mkdirSync(dir, { recursive: true })
  let cost = 0
  for (const [i, item] of items.entries()) {
    const jpg = join(dir, `${i + 1}.jpg`)
    if (!existsSync(jpg)) {
      const res = await fetch("https://openrouter.ai/api/v1/images", {
        method: "POST",
        headers: {
          authorization: `Bearer ${openrouter}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-nano-banana-2.1",
          prompt: `Photograph, natural light, no people, no text: ${PHOTO_SUBJECTS[i % 3]}.`,
          resolution: "1K",
          aspect_ratio: "4:3",
        }),
      })
      const body = await res.json()
      const image = body.data?.find((d) => d.b64_json)
      if (!image)
        throw new Error(
          `stand-in photo ${i + 1}: ${res.status} ${JSON.stringify(body).slice(0, 300)}`
        )
      cost += body.usage?.cost ?? 0
      const raw = join(dir, `${i + 1}.raw`)
      writeFileSync(raw, Buffer.from(image.b64_json, "base64"))
      execFileSync("sips", ["-s", "format", "jpeg", raw, "--out", jpg], {
        stdio: "ignore",
      })
    }
    execFileSync(
      "pnpm",
      [
        "--filter",
        "orchestrator",
        "exec",
        "wrangler",
        "r2",
        "object",
        "put",
        `reme-sites/uploads/${ORG_ID}/${item.id}`,
        "--file",
        resolve(jpg),
        "--content-type",
        "image/jpeg",
        "--local",
        "--persist-to",
        resolve(state),
      ],
      {
        env: { ...process.env, FORCE_COLOR: "0" },
        stdio: ["ignore", "ignore", "inherit"],
      }
    )
  }
  log(
    `placed ${items.length} owner photos (stand-ins cost $${cost.toFixed(4)})`
  )
  return cost
}

/** Polls an assignment to a settled state; answers "Build it" on a waiting Blueprint. */
async function watch(id, { timeoutMs, every, spentAtStart }) {
  const started = Date.now()
  const timeline = []
  let last = ""
  let row
  for (;;) {
    row = await call("GET", `/${id}`)
    const now = row.assignment.state
    if (now !== last) {
      timeline.push({ state: now, at_ms: Date.now() - started })
      log(`${id} ${now} ($${Number(row.cost_usd ?? 0).toFixed(4)})`)
      last = now
    }
    if (SETTLED.has(now)) break
    const { events } = await call("GET", `/${id}/events`)
    const round = awaitingRound(events)
    if (round) {
      log(`Blueprint round ${round} waits: Build it`)
      await call("POST", `/${id}/blueprint`, { decision: "build" })
      timeline.push({
        state: `blueprint ${round} decided`,
        at_ms: Date.now() - started,
      })
    }
    const spent = (await keyUsage()) - spentAtStart
    if (spent >= SPEND_STOP_USD || Date.now() - started > timeoutMs) {
      log(
        spent >= SPEND_STOP_USD
          ? `spend stop at $${spent.toFixed(2)}`
          : "timeout"
      )
      await call("POST", `/${id}/cancel`, {}).catch(() => undefined)
      timeline.push({ state: "stopped by driver", at_ms: Date.now() - started })
      break
    }
    await sleep(every)
  }
  const { events } = await call("GET", `/${id}/events`)
  return { row, events, timeline, wall_ms: Date.now() - started }
}

function save(name, result) {
  writeFileSync(
    join(out, `${name}.json`),
    `${JSON.stringify(result, null, 2)}\n`
  )
  writeFileSync(
    join(out, `${name}.events.jsonl`),
    `${result.events.map((e) => JSON.stringify(e)).join("\n")}\n`
  )
}

/** Points the local site at a revision so a revise has a base. DB only; see the header. */
async function serve(revisionId) {
  if (!revisionId) throw new Error("no revision to serve")
  const { sql: client } = connect()
  try {
    const [cur] =
      await client`select revision_id, config_version from deployments where site_id = ${ORG_ID} order by config_version desc limit 1`
    if (cur?.revision_id === revisionId) return
    await client`insert into deployments ${client({
      org_id: ORG_ID,
      site_id: ORG_ID,
      revision_id: revisionId,
      previous_revision_id: cur?.revision_id ?? null,
      config_version: (cur?.config_version ?? 0) + 1,
      kind: "rollback",
      reason: "local measurement base; never published",
    })}`
  } finally {
    await client.end()
  }
}

const latestRevision = (row) => row.revisions?.[0]?.revision_id

async function main() {
  const spentAtStart = await keyUsage()
  log(`OpenRouter key usage at start $${spentAtStart.toFixed(4)}`)
  const summary = {
    business: business.id,
    org: ORG_ID,
    slug: SLUG,
    key_usage_start: spentAtStart,
  }
  let buildId = args.build
  if (!buildId) {
    await seed()
    if (business.richness !== "bare")
      summary.stand_in_photo_cost = await placeUploads()
    const tray = toTray(business)
    const created = await call("POST", "", {
      kind: "site.build",
      ...(tray.skip_all ? { review: "skip" } : {}),
    })
    buildId = created.assignment_id
    log(`build ${buildId} created`)
    const build = await watch(buildId, {
      timeoutMs: BUILD_TIMEOUT_MS,
      every: 5_000,
      spentAtStart,
    })
    save("build", build)
    summary.build = {
      id: buildId,
      state: build.row.assignment.state,
      wall_ms: build.wall_ms,
      cost_usd: build.row.cost_usd,
      timeline: build.timeline,
    }
    if (build.row.assignment.state !== "preview_ready") {
      writeFileSync(
        join(out, "summary.json"),
        `${JSON.stringify(summary, null, 2)}\n`
      )
      throw new Error(`build settled in ${build.row.assignment.state}`)
    }
  }
  if (args.edits) {
    summary.edits = []
    let prev = await call("GET", `/${buildId}`)
    // `--variant b` changes what the hero and phone edits ask for, so a second
    // pass on the same site is not a no-op.
    const variant = {
      "hero-title": "Change the hero title to: Come home to breathing room.",
      phone:
        "Our phone number is now (206) 555-0177. Update it everywhere on the site.",
    }
    for (const canned of EDITS) {
      const edit =
        args.variant === "b" && variant[canned.name]
          ? {
              ...canned,
              goal: variant[canned.name],
              ...(canned.facts
                ? {
                    facts: [
                      {
                        key: "business.phone",
                        value: { e164: "+12065550177" },
                      },
                    ],
                  }
                : {}),
            }
          : canned
      if ((await keyUsage()) - spentAtStart >= SPEND_STOP_USD) break
      // An owner looks at the preview first; the last edit's screenshots
      // and warm keep run after its preview_ready.
      await sleep(Number(args["gap-ms"] ?? 0))
      await serve(latestRevision(prev))
      if (edit.facts) await call("POST", "/facts", { facts: edit.facts })
      const t0 = Date.now()
      const created = await call("POST", "", {
        kind: "site.revise",
        goal: edit.goal,
        change_kind: edit.change_kind,
      })
      const result = await watch(created.assignment_id, {
        timeoutMs: EDIT_TIMEOUT_MS,
        every: 500,
        spentAtStart,
      })
      result.wall_from_post_ms = Date.now() - t0
      save(`edit-${edit.name}`, result)
      summary.edits.push({
        name: edit.name,
        id: created.assignment_id,
        state: result.row.assignment.state,
        wall_ms: result.wall_from_post_ms,
        cost_usd: result.row.cost_usd,
        timeline: result.timeline,
      })
      if (result.row.assignment.state === "preview_ready") prev = result.row
    }
  }
  summary.key_usage_end = await keyUsage()
  writeFileSync(
    join(out, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`
  )
  log(
    `done; key usage rose $${(summary.key_usage_end - spentAtStart).toFixed(4)}`
  )
}

await main()
