import {
  CheckDomainOutput,
  ConnectDomainOutput,
  DomainCheck,
  DomainName,
  type DomainProvider,
  type DomainState,
  siteHost,
} from "@workspace/contracts"
import {
  appendEvent,
  domains,
  eq,
  type OrgScopedDb,
  orgs,
  pgCode,
  sql,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import {
  apexMode,
  CAA_FOR_US,
  type CloudflareEnv,
  type CustomHostname,
  DomainError,
  deleteHostname,
  detectProvider,
  domainCheck,
  ensureHostname,
  getHostname,
  inspect,
  OUR_ZONE,
  recordsFor,
} from "./domains.ts"
import {
  activeDeployment,
  dropDomainPointers,
  writePointer,
} from "./publish.ts"

/**
 * Connecting an owner's existing domain (records path): the step bodies of
 * `DomainWorkflow` and the three owner routes. Postgres is the truth for a
 * domain's state; Cloudflare holds the custom hostnames and KV the pointers,
 * both written from the row. The Workflow class is in domain-workflow.ts.
 */

export type DomainParams = { org_id: string; domain_id: string }
export const domainInstanceId = (domainId: string) => `domain-${domainId}`

/** A claim that is still connecting. */
const CONNECTING = ["awaiting_dns", "verifying"] as const
/** At most this many connecting claims per org (plan, Security: squatting). */
export const MAX_PENDING = 3
/** A claim not live by then fails and frees the name. */
export const DEADLINE_MS = 72 * 60 * 60 * 1000
/**
 * One reminder, with the provider again, for a claim still connecting a day
 * after it started. shortcut: counts from the start, not from the last status
 * change; move the clock to the last change if owners find it early.
 */
export const NUDGE_AFTER_MS = 24 * 60 * 60 * 1000
const MINUTE = 60 * 1000
const WAITS_MS = [2, 5, 15, 30].map((m) => m * MINUTE)
/** How long the `n`th look waits for a nudge before looking again. */
export const nextWait = (n: number) => WAITS_MS[n - 1] ?? 60 * MINUTE

type DomainRow = typeof domains.$inferSelect
type CfIds = { apex?: string; www?: string }

/** A kit for one step, closed when it ends. */
export async function withKit<T>(
  env: Pick<Env, "HYPERDRIVE">,
  fn: (kit: Tenancy) => Promise<T>
): Promise<T> {
  const kit = tenancy(env.HYPERDRIVE.connectionString)
  try {
    return await fn(kit)
  } finally {
    await kit.close()
  }
}

const connecting = (state: DomainState) =>
  (CONNECTING as readonly string[]).includes(state)

async function readDomain(db: OrgScopedDb, domainId: string) {
  const [row] = await db.select().from(domains).where(eq(domains.id, domainId))
  return row
}

async function slugHostOf(db: OrgScopedDb, env: Env, orgId: string) {
  const [org] = await db
    .select({ slug: orgs.slug })
    .from(orgs)
    .where(eq(orgs.id, orgId))
  return org ? siteHost(org.slug, env.SITE_HOST_SUFFIX) : null
}

/**
 * The owner's domain as we store it: the apex, lower case, without a trailing
 * dot or a `www.`. Null for anything that is not a domain, or is ours.
 */
export function normalizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const name = raw
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "")
  if (!DomainName.safeParse(name).success) return null
  if (name === OUR_ZONE || name.endsWith(`.${OUR_ZONE}`)) return null
  return name
}

/**
 * The one way a domain's progress reaches the owner. Keyed, so a retried step
 * says it once.
 *
 * shortcut: an events row until the assistant-message story lands its
 * helper; then this body calls that helper with the same key and text.
 */
export async function postStatus(
  kit: Tenancy,
  orgId: string,
  key: string,
  text: string
): Promise<void> {
  try {
    await kit.withOrg({ orgId }, (db) =>
      appendEvent(db, {
        orgId,
        assignmentId: null,
        staffId: null,
        type: "domain.status",
        payload: { key, text },
        idempotencyKey: `domain-status:${key}`,
      })
    )
  } catch (error) {
    if (pgCode(error) !== "23505") throw error
  }
}

/** What the owner is told when a look finds something new, or nothing worth a message. */
export function statusText(check: DomainCheck, name: string, primary: string) {
  switch (check.status) {
    case "conflicting_record": {
      const [first] = check.conflicts
      if (!first) return null
      if (first.type === "CAA") {
        return `Nearly there. ${name} has a CAA record that stops our certificate authority from issuing your secure certificate. Add a CAA record with the value ${CAA_FOR_US} and I'll pick it up from there.`
      }
      const host = first.name === "@" ? name : `${first.name}.${name}`
      return `Nearly there. ${host} still has an old ${first.type} record (${first.value}) in the way. Delete it and I'll pick it up from there.`
    }
    case "pending_certificate":
      return `I can see your records for ${primary}. Your secure certificate is being issued; I'll tell you when it's live.`
    case "invalid_configuration":
      return `${primary} no longer points at your website. Put the record back and I'll pick it up again.`
    default:
      return null
  }
}

/** The check's next step for the CoS, in one sentence. */
function nextStep(state: DomainState, check: DomainCheck, name: string) {
  if (state === "active") return `${name} is live. Nothing to do.`
  if (state === "failed")
    return `Connecting ${name} timed out. Offer to try again.`
  if (state === "removed")
    return `${name} was removed. Offer to connect it again.`
  return (
    statusText(check, name, `www.${name}`) ??
    "Nothing to do: the records are not there yet and I'm watching for them."
  )
}

/** Whether a host answers through our edge with a certificate: anything short of a 5xx. */
export async function reaches(host: string): Promise<boolean> {
  try {
    const response = await fetch(`https://${host}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    })
    await response.body?.cancel()
    return response.status < 500
  } catch {
    return false
  }
}

/**
 * The domain's check now, from public DNS and its two custom hostnames, and
 * the host it would be served on. Never throws: a failed read is
 * `unknown_error`, which the Workflow looks past.
 */
export async function currentCheck(
  env: CloudflareEnv,
  row: Pick<DomainRow, "name" | "cfIds" | "primaryHost">
): Promise<{ check: DomainCheck; primary: string }> {
  try {
    const ids = row.cfIds as CfIds
    const [inspection, apex, www] = await Promise.all([
      inspect(row.name),
      ids.apex ? getHostname(env, ids.apex) : null,
      ids.www ? getHostname(env, ids.www) : null,
    ])
    const wwwHost = `www.${row.name}`
    const alias = apexMode(inspection, apex) === "alias"
    const hosts: Array<{ host: string; hostname: CustomHostname | null }> = [
      ...(alias ? [{ host: row.name, hostname: apex }] : []),
      { host: wwwHost, hostname: www },
    ]
    return {
      check: domainCheck(inspection, hosts),
      primary: alias ? row.name : wwwHost,
    }
  } catch {
    return { check: { status: "unknown_error" }, primary: row.primaryHost }
  }
}

// ---------------------------------------------------------------------------
// Workflow steps
// ---------------------------------------------------------------------------

/**
 * The claim's two custom hostnames, the apex and `www`, created or found and
 * kept in `cf_ids`. `gone` for a claim no longer connecting, `held` when
 * Cloudflare has a hostname this claim does not own.
 */
export async function claimHostnames(
  env: Env,
  kit: Tenancy,
  orgId: string,
  domainId: string
): Promise<"gone" | "held" | CfIds> {
  const row = await kit.withOrg({ orgId }, (db) => readDomain(db, domainId))
  if (!row || !connecting(row.state)) return "gone"
  const owned = row.cfIds as CfIds
  let ids: CfIds
  try {
    const www = await ensureHostname(env, `www.${row.name}`, {
      id: owned.www,
      since: row.createdAt,
    })
    const apex = await ensureHostname(env, row.name, {
      id: owned.apex,
      since: row.createdAt,
    })
    ids = { apex: apex.id, www: www.id }
  } catch (error) {
    if (error instanceof DomainError && error.name === "domain.hostname_held")
      return "held"
    throw error
  }
  await kit.withOrg({ orgId }, (db) =>
    db.update(domains).set({ cfIds: ids }).where(eq(domains.id, domainId))
  )
  return ids
}

export type Seen =
  | { gone: true }
  | { gone: false; at: number; status: DomainCheck["status"]; ready: boolean }

/**
 * One look: the check, a message when it differs from the last one, and the
 * row brought up to date. Ready means valid and answering through our edge.
 * The message goes first and keyed by the look, so a retried step neither
 * loses it nor says it twice.
 */
export async function look(
  env: Env,
  kit: Tenancy,
  orgId: string,
  domainId: string,
  n: number
): Promise<Seen> {
  const row = await kit.withOrg({ orgId }, (db) => readDomain(db, domainId))
  if (!row || !connecting(row.state)) return { gone: true }
  const seen = await currentCheck(env, row)
  let check = seen.check
  const ready = check.status === "valid" && (await reaches(seen.primary))
  // Valid at Cloudflare but not yet answering: the certificate is still deploying.
  if (check.status === "valid" && !ready)
    check = { status: "pending_certificate" }
  if (JSON.stringify(row.lastCheck) !== JSON.stringify(check)) {
    const text = statusText(check, row.name, seen.primary)
    if (text) await postStatus(kit, orgId, `${domainId}:look:${n}`, text)
  }
  const state: DomainState =
    check.status === "pending_certificate" || check.status === "valid"
      ? "verifying"
      : "awaiting_dns"
  const updated = await kit.withOrg({ orgId }, (db) =>
    db
      .update(domains)
      .set({ lastCheck: check, state, primaryHost: seen.primary })
      .where(
        sql`${domains.id} = ${domainId} and ${domains.state} in ('awaiting_dns', 'verifying')`
      )
      .returning({ id: domains.id })
  )
  if (updated.length === 0) return { gone: true }
  return { gone: false, at: Date.now(), status: check.status, ready }
}

/** The 24-hour reminder, once, with where the owner's DNS settings are. */
export async function nudge(
  kit: Tenancy,
  orgId: string,
  domainId: string
): Promise<void> {
  const row = await kit.withOrg({ orgId }, (db) => readDomain(db, domainId))
  if (!row || !connecting(row.state)) return
  const provider = row.provider as DomainProvider | null
  const where = provider
    ? ` Your domain's settings are at ${provider.name}.`
    : ""
  await postStatus(
    kit,
    orgId,
    `${domainId}:nudge`,
    `I'm still waiting for the records for ${row.name}.${where} There's no need to tell me when they're in; I'll see them.`
  )
}

/**
 * The domain goes live: the row first, then every pointer written from it
 * (`writePointer` reads the active domain), then the owner is told. False
 * when the claim was removed meanwhile. A retry after the row moved finds it
 * active and writes the pointers again, which repeats what is live.
 */
export async function activateDomain(
  env: Env,
  kit: Tenancy,
  orgId: string,
  domainId: string
): Promise<boolean> {
  const done = await kit.withOrg({ orgId }, async (db) => {
    const row = await readDomain(db, domainId)
    if (!row || (row.state !== "active" && !connecting(row.state))) return null
    if (row.state !== "active") {
      await db
        .update(domains)
        .set({ state: "active", activatedAt: new Date() })
        .where(eq(domains.id, domainId))
      await appendEvent(db, {
        orgId,
        assignmentId: null,
        staffId: null,
        type: "domain.activated",
        payload: { domain_id: domainId, primary_host: row.primaryHost },
      })
    }
    return { row, slug: await slugHostOf(db, env, orgId) }
  })
  if (!done?.slug) return false
  await writePointer(env, kit, orgId, done.row.siteId, done.slug)
  await postStatus(
    kit,
    orgId,
    `${domainId}:active`,
    `${done.row.primaryHost} is live. ${done.slug} now forwards to it, so links you've shared still work.`
  )
  return true
}

/**
 * The claim fails: after 72 hours without going live, or when its hostname is
 * held elsewhere. The site stays on its slug host, the name is freed, the
 * hostnames are deleted, and the owner is told once.
 */
export async function expireDomain(
  env: Env,
  kit: Tenancy,
  orgId: string,
  domainId: string,
  reason: "timeout" | "held"
): Promise<void> {
  const found = await kit.withOrg({ orgId }, async (db) => {
    const row = await readDomain(db, domainId)
    if (!row || (row.state !== "failed" && !connecting(row.state))) return null
    if (row.state !== "failed") {
      await db
        .update(domains)
        .set({ state: "failed" })
        .where(eq(domains.id, domainId))
      await appendEvent(db, {
        orgId,
        assignmentId: null,
        staffId: null,
        type: "domain.failed",
        payload: { domain_id: domainId, reason },
      })
    }
    return { row, slug: await slugHostOf(db, env, orgId) }
  })
  if (!found) return
  for (const id of Object.values(found.row.cfIds as CfIds)) {
    if (id) await deleteHostname(env, id)
  }
  const where = found.slug ? ` Your site stays on ${found.slug}.` : ""
  await postStatus(
    kit,
    orgId,
    `${domainId}:failed`,
    reason === "held"
      ? `I couldn't connect ${found.row.name}: it's already set up somewhere else.${where}`
      : `I didn't see the records for ${found.row.name} within 3 days, so I've stopped watching.${where} Ask me again any time.`
  )
}

// ---------------------------------------------------------------------------
// Owner routes
// ---------------------------------------------------------------------------

export type Refusal = {
  refused: true
  status: 400 | 404 | 409 | 503
  class: "validation" | "resource" | "transient"
  code: string
  message: string
}
const refuse = (
  status: Refusal["status"],
  errorClass: Refusal["class"],
  code: string,
  message: string
): Refusal => ({ refused: true, status, class: errorClass, code, message })

const invalid = () =>
  refuse(
    400,
    "validation",
    "domain.invalid",
    "That isn't a domain we can connect: give the address itself, like sparkleclean.co.uk."
  )

/**
 * `POST /domains`: inspect the domain, claim it for the org and start its
 * Workflow, answering with the records to add. The same org asking again for
 * a name it is connecting gets the same answer; one name has one live claim
 * across orgs, and the unique index says so.
 */
export async function connect(
  env: Env,
  kit: Tenancy,
  orgId: string,
  body: { name?: unknown; approval_id?: unknown }
): Promise<Refusal | { status: 200 | 201; output: ConnectDomainOutput }> {
  const name = normalizeName(body.name)
  const approvalId = body.approval_id
  if (!name || typeof approvalId !== "string" || !approvalId.trim())
    return invalid()
  let inspection: Awaited<ReturnType<typeof inspect>>
  try {
    inspection = await inspect(name)
  } catch (error) {
    if (error instanceof DomainError && error.name === "domain.not_found")
      return invalid()
    return refuse(
      503,
      "transient",
      "dns.unavailable",
      "I couldn't read the domain's DNS just now. Try again in a minute."
    )
  }
  // A subdomain other than `www` has a zone apex above it.
  if (inspection.apex !== name) return invalid()
  const provider = await detectProvider(name, inspection.nameservers)
  const apex = apexMode(inspection, null)
  const output = ConnectDomainOutput.parse({
    outcome: "connecting",
    method: "records",
    email_affected: false,
    steps: recordsFor({ inspection, apex, hostnames: [], withTxt: false }),
    apex,
    ...(provider && { provider }),
  })
  let claimed: Refusal | { id: string | null }
  try {
    claimed = await kit.withOrg({ orgId }, async (db) => {
      const [held] = await db
        .select({ state: domains.state })
        .from(domains)
        .where(
          sql`${domains.name} = ${name} and ${domains.state} in ('awaiting_dns', 'verifying', 'active')`
        )
      if (held?.state === "active")
        return refuse(
          409,
          "resource",
          "domain.in_use",
          `${name} is already live on this site.`
        )
      if (held) return { id: null }
      if (!(await activeDeployment(db, orgId)))
        return refuse(
          409,
          "resource",
          "site.not_published",
          "Publish the site first, then connect a domain to it."
        )
      const [pending] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(domains)
        .where(sql`${domains.state} in ('awaiting_dns', 'verifying')`)
      if ((pending?.n ?? 0) >= MAX_PENDING)
        return refuse(
          409,
          "resource",
          "domain.too_many_pending",
          "There are already three domains waiting for their records. Finish or remove one first."
        )
      const [row] = await db
        .insert(domains)
        .values({
          orgId,
          siteId: orgId,
          name,
          primaryHost: apex === "alias" ? name : `www.${name}`,
          origin: "connected",
          method: "records",
          state: "awaiting_dns",
          onCloudflare: inspection.onCloudflare,
          provider: provider ?? null,
        })
        .returning({ id: domains.id })
      if (!row) throw new Error("domains insert returned nothing")
      await appendEvent(db, {
        orgId,
        assignmentId: null,
        staffId: null,
        type: "domain.connect_requested",
        payload: { domain_id: row.id, name, approval_id: approvalId },
      })
      return { id: row.id }
    })
  } catch (error) {
    if (pgCode(error) === "23505")
      return refuse(
        409,
        "resource",
        "domain.in_use",
        `${name} is already connected to another website.`
      )
    throw error
  }
  if ("refused" in claimed) return claimed
  if (claimed.id) await start(env, orgId, claimed.id)
  return { status: claimed.id ? 201 : 200, output }
}

/** The claim's Workflow, created; one already there is fine. */
async function start(env: Env, orgId: string, domainId: string) {
  try {
    await env.DOMAINS.create({
      id: domainInstanceId(domainId),
      params: { org_id: orgId, domain_id: domainId },
    })
  } catch {
    // Already created: the id is the claim's.
  }
}

/** The org's newest row for a name, removed ones included. */
async function latestFor(db: OrgScopedDb, name: string) {
  const [row] = await db
    .select()
    .from(domains)
    .where(eq(domains.name, name))
    .orderBy(sql`${domains.createdAt} desc`)
    .limit(1)
  return row
}

/**
 * `POST /domains/{name}/check`: the check now, for a claim still connecting,
 * and a nudge so its Workflow looks too; the stored state for any other. A
 * Workflow that cannot take the nudge is created again, which recovers a
 * claim whose create failed after the row was written.
 */
export async function checkNow(
  env: Env,
  kit: Tenancy,
  orgId: string,
  rawName: string
): Promise<Refusal | CheckDomainOutput> {
  const name = normalizeName(rawName)
  if (!name) return invalid()
  const row = await kit.withOrg({ orgId }, (db) => latestFor(db, name))
  if (!row)
    return refuse(
      404,
      "resource",
      "domain.not_found",
      `${name} isn't connected to this site.`
    )
  let status: DomainCheck
  if (connecting(row.state)) {
    status = (await currentCheck(env, row)).check
    try {
      const instance = await env.DOMAINS.get(domainInstanceId(row.id))
      await instance.sendEvent({ type: "check", payload: {} })
    } catch {
      await start(env, orgId, row.id)
    }
  } else {
    const stored = DomainCheck.safeParse(row.lastCheck)
    status =
      row.state === "active"
        ? { status: "valid" }
        : stored.success
          ? stored.data
          : { status: "not_found" }
  }
  return CheckDomainOutput.parse({
    outcome: "checked",
    state: row.state,
    status,
    next_step: nextStep(row.state, status, name),
  })
}

/**
 * `DELETE /domains/{name}`: the row first, so no look can activate it again;
 * then, for a live domain, its two pointers and the slug host pointed back at
 * the site; then the hostnames and the Workflow. A repeat finds the row
 * removed and deletes the hostnames again, which is idempotent.
 */
export async function remove(
  env: Env,
  kit: Tenancy,
  orgId: string,
  rawName: string
): Promise<Refusal | null> {
  const name = normalizeName(rawName)
  if (!name) return invalid()
  const found = await kit.withOrg({ orgId }, async (db) => {
    const row = await latestFor(db, name)
    if (!row) return null
    if (row.state !== "removed") {
      await db
        .update(domains)
        .set({ state: "removed", removedAt: new Date() })
        .where(eq(domains.id, row.id))
      await appendEvent(db, {
        orgId,
        assignmentId: null,
        staffId: null,
        type: "domain.removed",
        payload: { domain_id: row.id, was: row.state },
      })
    }
    return { row, slug: await slugHostOf(db, env, orgId) }
  })
  if (!found)
    return refuse(
      404,
      "resource",
      "domain.not_found",
      `${name} isn't connected to this site.`
    )
  if (found.row.state === "active") {
    await dropDomainPointers(env, found.row.primaryHost)
    if (found.slug) {
      try {
        await writePointer(env, kit, orgId, found.row.siteId, found.slug)
      } catch (error) {
        // A closed org keeps no pointer at all; anything else is a failure.
        if ((error as { code?: string }).code !== "org.closed") throw error
      }
    }
  }
  for (const id of Object.values(found.row.cfIds as CfIds)) {
    if (id) await deleteHostname(env, id)
  }
  try {
    const instance = await env.DOMAINS.get(domainInstanceId(found.row.id))
    await instance.terminate()
  } catch {
    // Already ended, or never started.
  }
  return null
}
