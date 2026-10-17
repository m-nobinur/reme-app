/**
 * `pnpm probe:clear`: deletes the orgs the onboarding e2e run leaves on
 * staging, every layer of them, and nothing else (ADR-032, amendment
 * 2026-09-28).
 *
 *   --probe <id>   one probe, by our org id or its WorkOS org id (a spec's teardown)
 *   --reap         every probe older than an hour, and WorkOS leftovers
 *   --org <id>     a leftover that fails the name or member test
 *   --yes          delete; without it the run prints the plan and stops
 *
 * Staging by construction. The database URL comes from `NEON_API_KEY` and the
 * branch id below, never from `DATABASE_URL`. The KV namespace, the bucket and
 * the host suffix come from the orchestrator's top-level wrangler config, which
 * is staging. A WorkOS client or key that is not staging's is refused.
 *
 * Per org, inside one transaction as `neondb_owner`: lock the org row, check
 * the assignments again, delete the KV routing key and the R2 files under
 * `sites/<site>/`, then `clearOrgs`. The WorkOS org and users go after the
 * commit. Each step counts "already gone" as done. A failed Cloudflare delete
 * rolls the transaction back, so Postgres still names what is left. A crash
 * after the commit leaves WorkOS rows no Postgres row names, which `--reap`
 * finds by name, age and member addresses and finishes.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { type AssignmentState, TERMINAL_STATES } from "@workspace/contracts"
import { sql as dsql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import ts from "typescript"
import { stagingRefusal as workosRefusal } from "../../../apps/api/scripts/dev-owner.mjs"
import {
  call,
  deleteProbeOrg,
  deleteProbeUser,
  isProbeEmail,
  PROBE_ORG_PREFIX,
  staleProbeUsers,
} from "../../../qa/e2e/workos.ts"
import { clearOrgs } from "../fixtures/seed.ts"
import type { connect } from "../src/client.ts"
import * as schema from "../src/schema.ts"

/** Staging's Neon project and its `main` branch, read from the Neon API 2026-10-17. */
export const STAGING = {
  neonProject: "silent-sun-14056263",
  neonBranch: "br-withered-king-baxrx6ke",
  hostSuffix: "-stg.remeai.co.uk",
} as const

const HOUR = 60 * 60 * 1000
const ROOT = new URL("../../../", import.meta.url)
const WRANGLER = new URL("apps/orchestrator/wrangler.jsonc", ROOT)

/** Why this run must not touch the target, or null when it is staging. */
export async function stagingRefusal(
  target: {
    neonProject: string
    neonBranch: string
    hostSuffix: string
    workosClientId: string
    workosApiKey: string
  },
  fetcher: typeof fetch = fetch
): Promise<string | null> {
  if (
    target.neonProject !== STAGING.neonProject ||
    target.neonBranch !== STAGING.neonBranch
  ) {
    return `Neon ${target.neonProject}/${target.neonBranch} is not staging's branch.`
  }
  if (target.hostSuffix !== STAGING.hostSuffix) {
    return `the wrangler config serves ${target.hostSuffix}, not staging's ${STAGING.hostSuffix}.`
  }
  return workosRefusal(
    { clientId: target.workosClientId, apiKey: target.workosApiKey },
    fetcher
  )
}

/**
 * Why an org is not a probe, or null when it is. `--org` skips the name and
 * member tests and keeps the assignment test.
 */
export function probeRefusal(
  org: { name: string; emails: readonly string[]; states: readonly string[] },
  mode: "probe" | "org"
): string | null {
  const open = org.states.filter(
    (state) => !TERMINAL_STATES.includes(state as AssignmentState)
  )
  if (open.length > 0) return `unfinished assignment(s): ${open.join(", ")}`
  if (mode === "org") return null
  if (!org.name.startsWith(PROBE_ORG_PREFIX)) {
    return `the name does not start with "${PROBE_ORG_PREFIX}"`
  }
  if (org.emails.length === 0) return "no member vouches for it"
  const other = org.emails.find((email) => !isProbeEmail(email))
  return other ? `member ${other} is not a qa-e2e address` : null
}

function need(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set (see .env.local).`)
  return value
}

/** The staging bindings, from the config wrangler deploys with. */
function stagingBindings() {
  const parsed = ts.parseConfigFileTextToJson(
    WRANGLER.pathname,
    readFileSync(WRANGLER, "utf8")
  )
  if (parsed.error) throw new Error(`${WRANGLER.pathname} does not parse`)
  const config = parsed.config as {
    vars: { SITE_HOST_SUFFIX: string }
    kv_namespaces: { binding: string; id: string }[]
    r2_buckets: { binding: string; bucket_name: string }[]
  }
  const kv = config.kv_namespaces.find((k) => k.binding === "ROUTES")?.id
  const bucket = config.r2_buckets.find(
    (b) => b.binding === "SITES"
  )?.bucket_name
  if (!kv || !bucket) throw new Error("no ROUTES or SITES binding at the top")
  return { kv, bucket, hostSuffix: config.vars.SITE_HOST_SUFFIX }
}

async function databaseUrl(): Promise<string> {
  const query = new URLSearchParams({
    branch_id: STAGING.neonBranch,
    database_name: "neondb",
    role_name: "neondb_owner",
  })
  const response = await fetch(
    `https://console.neon.tech/api/v2/projects/${STAGING.neonProject}/connection_uri?${query}`,
    { headers: { authorization: `Bearer ${need("NEON_API_KEY")}` } }
  )
  const body = (await response.json().catch(() => ({}))) as { uri?: string }
  if (!body.uri)
    throw new Error(`Neon gave no connection uri: ${response.status}`)
  return body.uri
}

type Fetch = typeof fetch
type Env = { kv: string; bucket: string; hostSuffix: string }
type Db = ReturnType<typeof connect>["db"]

async function cloudflare(
  fetcher: Fetch,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetcher(
    `https://api.cloudflare.com/client/v4/accounts/${need("CLOUDFLARE_ACCOUNT_ID")}${path}`,
    {
      ...init,
      headers: {
        authorization: `Bearer ${need("CLOUDFLARE_API_TOKEN")}`,
        "content-type": "application/json",
      },
    }
  )
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text)
  } catch {
    // A KV value read answers raw bytes; the status carries the meaning.
  }
  return { status: response.status, body }
}

function ok(
  answer: { status: number; body: Record<string, unknown> },
  what: string
) {
  if (answer.status >= 300 || answer.body.success === false) {
    throw new Error(
      `${what}: ${answer.status} ${JSON.stringify(answer.body.errors ?? answer.body)}`
    )
  }
  return answer.body
}

async function r2Keys(
  fetcher: Fetch,
  bucket: string,
  prefix: string
): Promise<string[]> {
  const keys: string[] = []
  let cursor = ""
  do {
    const query = new URLSearchParams({ prefix, per_page: "1000" })
    if (cursor) query.set("cursor", cursor)
    const body = ok(
      await cloudflare(fetcher, `/r2/buckets/${bucket}/objects?${query}`),
      `list ${prefix}`
    )
    keys.push(...(body.result as { key: string }[]).map((o) => o.key))
    // Absent on an empty listing.
    const info = body.result_info as
      | { cursor?: string; is_truncated?: boolean }
      | undefined
    cursor = info?.is_truncated ? (info.cursor ?? "") : ""
  } while (cursor)
  return keys
}

type Plan = {
  id: string
  name: string
  workosOrganizationId: string | null
  refusal: string | null
  slug: string
  kvKeys: { key: string; present: boolean }[]
  r2: { prefix: string; keys: string[] }[]
  members: { workosUserId: string; email: string; orgs: number }[]
}

/** One site per org today, seeded equal to the org id; the sandbox's checkpoints sit under the org id too (apps/orchestrator/src/sandbox.ts). */
const siteIds = (orgId: string) => dsql`
  select ${orgId}::uuid as site_id
  union select site_id from site_revisions where org_id = ${orgId}
  union select site_id from deployments where org_id = ${orgId}`

/** The layout retention deletes by (apps/orchestrator/src/retention.ts), one level up: every revision of the site. */
const sitePrefix = (siteId: string) => `sites/${siteId}/`

/** The router's key for a published host (apps/orchestrator/src/publish.ts). */
const hostKey = (slug: string, env: Env) => `host:${slug}${env.hostSuffix}`

async function planFor(
  db: Db,
  org: {
    id: string
    slug: string
    name: string
    workos_organization_id: string | null
  },
  mode: "probe" | "org",
  env: Env
): Promise<Plan> {
  const members = await db.execute<{
    workos_user_id: string
    email: string
    orgs: number
  }>(dsql`select u.workos_user_id, u.email,
       (select count(*)::int from memberships o where o.user_id = u.id) as orgs
     from memberships m join users u on u.id = m.user_id
     where m.org_id = ${org.id}`)
  const states = await db.execute<{ state: string }>(
    dsql`select state::text from assignments where org_id = ${org.id}`
  )
  const refusal = probeRefusal(
    {
      name: org.name,
      emails: members.map((m) => m.email),
      states: states.map((s) => s.state),
    },
    mode
  )
  const plan: Plan = {
    id: org.id,
    name: org.name,
    slug: org.slug,
    workosOrganizationId: org.workos_organization_id,
    refusal,
    kvKeys: [],
    r2: [],
    members: members.map((m) => ({
      workosUserId: m.workos_user_id,
      email: m.email,
      orgs: m.orgs,
    })),
  }
  if (refusal) return plan
  const key = hostKey(org.slug, env)
  const read = await cloudflare(
    fetch,
    `/storage/kv/namespaces/${env.kv}/values/${encodeURIComponent(key)}`
  )
  if (read.status !== 200 && read.status !== 404) ok(read, `read ${key}`)
  plan.kvKeys.push({ key, present: read.status === 200 })
  for (const { site_id } of await db.execute<{ site_id: string }>(
    siteIds(org.id)
  )) {
    const prefix = sitePrefix(site_id)
    plan.r2.push({ prefix, keys: await r2Keys(fetch, env.bucket, prefix) })
  }
  return plan
}

/**
 * One org's KV key, R2 files and Postgres rows, in one transaction that holds
 * the org row. An assignment insert takes a key-share lock on that row for its
 * foreign key, so no build can start while this runs, and the assignment check
 * below sees everything that exists. A Cloudflare delete that fails throws, the
 * transaction rolls back, and Postgres still names the site for the next run.
 * Returns the WorkOS user ids to delete once it has committed: members whose
 * only remaining membership was this org, decided here rather than up front,
 * so a user in two probes goes with the second.
 */
export async function clearOrg(
  db: Db,
  org: { id: string; slug: string },
  env: Env,
  fetcher: Fetch = fetch
): Promise<{ workosUserIds: string[] }> {
  return db.transaction(async (tx) => {
    const held = await tx.execute(
      dsql`select 1 from orgs where id = ${org.id} for update`
    )
    if (held.length === 0) return { workosUserIds: [] }
    const states = await tx.execute<{ state: string }>(
      dsql`select state::text from assignments where org_id = ${org.id}`
    )
    const refusal = probeRefusal(
      { name: "", emails: [], states: states.map((s) => s.state) },
      "org"
    )
    if (refusal) throw new Error(`${org.id} changed under the run: ${refusal}`)

    const kv = ok(
      await cloudflare(
        fetcher,
        `/storage/kv/namespaces/${env.kv}/bulk/delete`,
        { method: "POST", body: JSON.stringify([hostKey(org.slug, env)]) }
      ),
      "delete routing keys"
    )
    const failed = (kv.result as { unsuccessful_keys?: string[] } | null)
      ?.unsuccessful_keys
    if (failed?.length) {
      throw new Error(`KV kept ${failed.join(", ")}`)
    }

    for (const { site_id } of await tx.execute<{ site_id: string }>(
      siteIds(org.id)
    )) {
      const prefix = sitePrefix(site_id)
      // Explicit keys only. This endpoint's prefix mode is never used, because
      // an empty prefix there empties the bucket.
      const keys = await r2Keys(fetcher, env.bucket, prefix)
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000)
        if (!batch.every((k) => k.startsWith(prefix))) {
          throw new Error(`R2 listed a key outside ${prefix}`)
        }
        ok(
          await cloudflare(fetcher, `/r2/buckets/${env.bucket}/objects`, {
            method: "DELETE",
            body: JSON.stringify(batch),
          }),
          `delete under ${prefix}`
        )
      }
      // A per-key failure arrives inside a 200, so the listing is the proof.
      const left = await r2Keys(fetcher, env.bucket, prefix)
      if (left.length > 0) {
        throw new Error(`R2 kept ${left.length} object(s) under ${prefix}`)
      }
    }

    const sole = await tx.execute<{ id: string; workos_user_id: string }>(
      dsql`select u.id, u.workos_user_id
         from memberships m join users u on u.id = m.user_id
         where m.org_id = ${org.id}
           and not exists (select 1 from memberships o
                           where o.user_id = u.id and o.org_id <> ${org.id})`
    )
    await clearOrgs(
      tx,
      [org.id],
      sole.map((u) => u.id)
    )
    return { workosUserIds: sole.map((u) => u.workos_user_id) }
  })
}

async function deleteUser(id: string) {
  if (!(await deleteProbeUser(id))) throw new Error(`WorkOS still holds ${id}`)
}

function print(plan: Plan) {
  if (plan.refusal) {
    console.log(`refused  ${plan.id}  "${plan.name}": ${plan.refusal}`)
    return
  }
  console.log(`clear    ${plan.id}  "${plan.name}"`)
  for (const k of plan.kvKeys) {
    console.log(`  kv      ${k.key} (${k.present ? "present" : "absent"})`)
  }
  for (const r of plan.r2)
    console.log(`  r2      ${r.prefix} ${r.keys.length} object(s)`)
  console.log(
    `  db      clearOrgs; members ${
      plan.members
        .map((m) => `${m.email}${m.orgs > 1 ? ` (in ${m.orgs} orgs)` : ""}`)
        .join(", ") || "(none)"
    }`
  )
  console.log(
    `  workos  org ${plan.workosOrganizationId ?? "(none)"}; users ${
      plan.members.map((m) => m.workosUserId).join(", ") || "(none)"
    }, each once no other org holds it`
  )
}

type WorkosOrg = { id: string; name: string; created_at: string }
type WorkosUser = { id: string; email: string }

/** WorkOS rows a crash after the database commit left: no Postgres row names them. */
async function workosLeftovers(db: Db) {
  const known = await db.execute<{ id: string }>(dsql`
    select workos_organization_id as id from orgs where workos_organization_id is not null`)
  const knownUsers = await db.execute<{ id: string }>(
    dsql`select workos_user_id as id from users`
  )
  const inPostgres = new Set([...known, ...knownUsers].map((r) => r.id))
  // ponytail: first 100 orgs, the same ceiling as qa/e2e's reaper; page when staging holds more.
  const listed = await call("/organizations?limit=100")
  if (listed.status !== 200)
    throw new Error(`WorkOS did not list orgs: ${listed.status}`)
  const orgs: {
    org: WorkosOrg
    users: WorkosUser[]
    refusal: string | null
  }[] = []
  for (const org of (listed.body.data ?? []) as WorkosOrg[]) {
    if (!org.name.startsWith(PROBE_ORG_PREFIX) || inPostgres.has(org.id))
      continue
    if (Date.parse(org.created_at) > Date.now() - HOUR) continue
    const members = await call(
      `/user_management/users?organization_id=${org.id}&limit=100`
    )
    const users = (members.body.data ?? []) as WorkosUser[]
    orgs.push({
      org,
      users,
      refusal: probeRefusal(
        { name: org.name, emails: users.map((u) => u.email), states: [] },
        "probe"
      ),
    })
  }
  const taken = new Set(orgs.flatMap((o) => o.users.map((u) => u.id)))
  const users = (await staleProbeUsers()).filter(
    (id) => !inPostgres.has(id) && !taken.has(id)
  )
  return { orgs, users }
}

async function main() {
  const { values } = parseArgs({
    options: {
      probe: { type: "string" },
      org: { type: "string" },
      reap: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
    },
  })
  const modes = [values.probe, values.org, values.reap || undefined].filter(
    Boolean
  )
  if (modes.length !== 1) {
    console.error(
      "usage: pnpm probe:clear (--probe <id> | --org <id> | --reap) [--yes]"
    )
    process.exit(2)
  }
  try {
    process.loadEnvFile(new URL(".env.local", ROOT))
  } catch {
    // No .env.local: the variables come from the environment or `need` names them.
  }

  const env = stagingBindings()
  const refusal = await stagingRefusal({
    neonProject: STAGING.neonProject,
    neonBranch: STAGING.neonBranch,
    hostSuffix: env.hostSuffix,
    workosClientId: process.env.WORKOS_CLIENT_ID ?? "",
    workosApiKey: process.env.WORKOS_API_KEY ?? "",
  })
  if (refusal) {
    console.error(`refusing: ${refusal}`)
    process.exit(1)
  }

  const mode = values.org ? "org" : "probe"
  const sql = postgres(await databaseUrl(), {
    max: 1,
    onnotice: () => undefined,
  })
  const db = drizzle(sql, { schema })
  try {
    const id = values.probe ?? values.org
    type Row = {
      id: string
      slug: string
      name: string
      workos_organization_id: string | null
    }
    const orgs = id
      ? await sql<Row[]>`select id, slug, name, workos_organization_id from orgs
          where ${id.startsWith("org_") ? sql`workos_organization_id = ${id}` : sql`id = ${id}::uuid`}`
      : await sql<Row[]>`select id, slug, name, workos_organization_id from orgs
          where starts_with(name, ${PROBE_ORG_PREFIX})
            and created_at < now() - interval '1 hour'
          order by created_at`
    // Exit 3, so a teardown against a preview, whose rows live on a Neon
    // branch this script never reads, knows to delete the WorkOS org itself.
    if (id && orgs.length === 0) {
      console.log(`no org ${id} in Postgres; nothing to clear there`)
      process.exitCode = 3
    }

    const plans: Plan[] = []
    for (const org of orgs) {
      const plan = await planFor(db, org, mode, env)
      plans.push(plan)
      print(plan)
    }
    const leftovers = values.reap
      ? await workosLeftovers(db)
      : { orgs: [], users: [] }
    for (const { org, users, refusal: why } of leftovers.orgs) {
      console.log(
        why
          ? `refused  workos ${org.id}  "${org.name}": ${why}`
          : `clear    workos ${org.id}  "${org.name}", users ${users.map((u) => `${u.id} ${u.email}`).join(", ")}`
      )
    }
    for (const user of leftovers.users)
      console.log(`clear    workos user ${user}`)

    const due = plans.filter((p) => !p.refusal)
    const dueOrgs = leftovers.orgs.filter((o) => !o.refusal)
    console.log(
      `\n${due.length} org(s) to clear, ${plans.length - due.length} refused; ` +
        `${dueOrgs.length} WorkOS org(s) and ${leftovers.users.length} WorkOS user(s) left over.`
    )
    // A refusal fails the run, so a spec's teardown that meets one goes red.
    if (plans.some((p) => p.refusal)) process.exitCode = 1
    if (!values.yes) {
      console.log("Dry run. Nothing was deleted; add --yes to delete.")
      return
    }
    for (const plan of due) {
      const { workosUserIds } = await clearOrg(db, plan, env)
      if (plan.workosOrganizationId) {
        await deleteProbeOrg(plan.workosOrganizationId)
      }
      for (const user of workosUserIds) await deleteUser(user)
      console.log(`cleared  ${plan.id}`)
    }
    for (const { org, users } of dueOrgs) {
      await deleteProbeOrg(org.id)
      for (const user of users) await deleteUser(user.id)
      console.log(`cleared  workos ${org.id}`)
    }
    for (const user of leftovers.users) await deleteUser(user)
  } finally {
    await sql.end()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
