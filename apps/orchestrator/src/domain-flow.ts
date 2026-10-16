import {
  CheckDomainOutput,
  ConnectDomainOutput,
  DomainCheck,
  DomainName,
  DomainProvider,
  type DomainState,
  type ServerButton,
  siteHost,
} from "@workspace/contracts"
import {
  appendEvent,
  domainHeldElsewhere,
  domains,
  eq,
  type OrgScopedDb,
  orgs,
  pgCode,
  postAssistantMessage,
  sql,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import {
  alreadyPointsAtUs,
  apexMode,
  CAA_FOR_US,
  type CloudflareEnv,
  CNAME_TARGET,
  type CustomHostname,
  DomainError,
  deleteHostname,
  detectProvider,
  domainCheck,
  ensureHostname,
  getHostname,
  hasTxt,
  inspect,
  OUR_ZONE,
  recordsFor,
  relative,
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

/**
 * R8: ids only. `settle` is the short instance a removal starts, which only
 * rewrites the pointers once more after `SETTLE`.
 */
export type DomainParams = { org_id: string; domain_id: string; settle?: true }
export const domainInstanceId = (domainId: string) => `domain-${domainId}`
const settleInstanceId = (domainId: string) => `domain-${domainId}-removed`

/**
 * How long after a state flip the pointers are written again: the router's
 * KV-miss path writes back what it read from Postgres, and a read from just
 * before the flip can land after our first write.
 */
export const SETTLE = "30 seconds"

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
/** Cloudflare's `ownership_verification` TXT per host, as `domains.ownership` keeps it. */
type Ownership = Record<string, { name: string; value: string }>

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

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/**
 * A status key as an event's key: 26 Crockford characters from its SHA-256,
 * the shape of `events.idempotency_key` (a ULID), as `eventKey` in
 * apps/api/src/http.ts makes them, so the org's unique index refuses a repeat.
 */
async function eventKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`domain.status:${key}`)
  )
  // 128 bits as 26 base-32 digits: the first is at most 3, inside a ULID's 0 to 7.
  let n = new Uint8Array(digest)
    .slice(0, 16)
    .reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n)
  let out = ""
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(n % 32n)] + out
    n /= 32n
  }
  return out
}

/**
 * A message for the owner, which a step body returns and the Workflow posts
 * in a step of its own, so a busy chat retries the post and nothing else.
 */
export type Say = { key: string; text: string; button?: ServerButton }

/**
 * The one way a domain's progress reaches the owner: a `domain.status` events
 * row for the audit, then the assistant's own message in the chat, both keyed
 * so a retry says it once. A chat in a turn (`busy`) or holding an unanswered
 * card (`waiting`) throws, for the step's retries; `exists` is a retry of a
 * post that landed; `none` is an org with no conversation, logged and done.
 */
export async function postStatus(
  kit: Tenancy,
  orgId: string,
  say: Say
): Promise<void> {
  const idempotencyKey = await eventKey(say.key)
  try {
    await kit.withOrg({ orgId }, (db) =>
      appendEvent(db, {
        orgId,
        assignmentId: null,
        staffId: null,
        type: "domain.status",
        payload: { key: say.key, text: say.text },
        idempotencyKey,
      })
    )
  } catch (error) {
    if (pgCode(error) !== "23505") throw error
  }
  const posted = await postAssistantMessage(kit, {
    orgId,
    key: `domain.status:${say.key}`,
    message: { text: [say.text], ...(say.button && { button: say.button }) },
  })
  if (posted === "busy" || posted === "waiting") {
    throw new DomainError(`status.${posted}`)
  }
  if (posted === "none") {
    console.log(
      JSON.stringify({ code: "domain.status_unposted", key: say.key })
    )
  }
}

/** The owner's DNS page as a button, when detection gave us one of our links. */
function settingsButton(provider: unknown): ServerButton | undefined {
  const known = DomainProvider.safeParse(provider)
  if (!known.success || !known.data.settings_url) return undefined
  const label = `Open ${known.data.name} DNS settings`
  return {
    label: label.length <= 60 ? label : "Open your DNS settings",
    action: { kind: "open", url: known.data.settings_url },
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

/** Statuses a check reaches only once Cloudflare holds the hostnames verified. */
const PAST_VERIFICATION: DomainCheck["status"][] = [
  "invalid_configuration",
  "pending_certificate",
  "valid",
]

/** Every host's stored ownership TXT is in public DNS; a host with none fails. */
async function ownedByTxt(
  ownership: Ownership,
  hosts: Array<{ host: string }>
): Promise<boolean> {
  const seen = await Promise.all(
    hosts.map(({ host }) => {
      const own = ownership[host]
      return own ? hasTxt(own.name, own.value) : false
    })
  )
  return seen.every(Boolean)
}

/**
 * The domain's check now, from public DNS and its two custom hostnames, and
 * the host it would be served on. Never throws: a failed read is
 * `unknown_error`, which the Workflow looks past.
 */
export async function currentCheck(
  env: CloudflareEnv,
  row: Pick<
    DomainRow,
    "name" | "cfIds" | "primaryHost" | "needsTxt" | "ownership"
  >
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
    let check = domainCheck(inspection, hosts)
    // The takeover guard: a name another org held, or one that pointed at us
    // before this claim, is not verified until each host's ownership TXT is
    // in public DNS. Cloudflare's own `active` may come from the CNAME alone.
    if (
      row.needsTxt &&
      PAST_VERIFICATION.includes(check.status) &&
      !(await ownedByTxt(row.ownership as Ownership, hosts))
    ) {
      check = { status: "pending_verification" }
    }
    return { check, primary: alias ? row.name : wwwHost }
  } catch {
    return { check: { status: "unknown_error" }, primary: row.primaryHost }
  }
}

// ---------------------------------------------------------------------------
// Workflow steps
// ---------------------------------------------------------------------------

/**
 * The claim's two custom hostnames, the apex and `www`, created or found and
 * kept in `cf_ids`, with each one's ownership TXT in `ownership`. Each id is stored as soon as its hostname exists, so a
 * retry after the second create fails still owns the first. `gone` for a
 * claim no longer connecting, `held` when Cloudflare has a hostname this
 * claim does not own.
 */
export async function claimHostnames(
  env: Env,
  kit: Tenancy,
  orgId: string,
  domainId: string
): Promise<"gone" | "held" | CfIds> {
  const row = await kit.withOrg({ orgId }, (db) => readDomain(db, domainId))
  if (!row || !connecting(row.state)) return "gone"
  const ids = { ...(row.cfIds as CfIds) }
  const ownership = { ...(row.ownership as Ownership) }
  const hosts = [
    ["www", `www.${row.name}`],
    ["apex", row.name],
  ] as const
  for (const [key, host] of hosts) {
    try {
      const hostname = await ensureHostname(env, host, { id: ids[key] })
      ids[key] = hostname.id
      const own = hostname.ownership_verification
      if (own?.name && own.value) {
        ownership[host] = { name: own.name, value: own.value }
      }
    } catch (error) {
      if (error instanceof DomainError && error.name === "domain.hostname_held")
        return "held"
      throw error
    }
    await kit.withOrg({ orgId }, (db) =>
      db
        .update(domains)
        .set({ cfIds: ids, ownership })
        .where(eq(domains.id, domainId))
    )
  }
  return ids
}

export type Seen =
  | { gone: true }
  | {
      gone: false
      at: number
      status: DomainCheck["status"]
      ready: boolean
      /** What to tell the owner, when the check differs from the last one. */
      say?: Say
    }

/**
 * One look: the check, the row brought up to date, and a message when the
 * check differs from the last one. Ready means valid and answering through
 * our edge. The message is keyed by the look and returned with the step's
 * result, so the Workflow's own post step neither loses it nor says it twice.
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
  const text =
    JSON.stringify(row.lastCheck) === JSON.stringify(check)
      ? null
      : statusText(check, row.name, seen.primary)
  const button =
    check.status === "conflicting_record" ||
    check.status === "invalid_configuration"
      ? settingsButton(row.provider)
      : undefined
  const say: Say | undefined = text
    ? { key: `${domainId}:look:${n}`, text, ...(button && { button }) }
    : undefined
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
  return {
    gone: false,
    at: Date.now(),
    status: check.status,
    ready,
    ...(say && { say }),
  }
}

/** The 24-hour reminder, once, with where the owner's DNS settings are. */
export async function nudge(
  kit: Tenancy,
  orgId: string,
  domainId: string
): Promise<Say | null> {
  const row = await kit.withOrg({ orgId }, (db) => readDomain(db, domainId))
  if (!row || !connecting(row.state)) return null
  const provider = DomainProvider.safeParse(row.provider)
  const where = provider.success
    ? ` Your domain's settings are at ${provider.data.name}.`
    : ""
  const button = settingsButton(row.provider)
  return {
    key: `${domainId}:nudge`,
    text: `I'm still waiting for the records for ${row.name}.${where} There's no need to tell me when they're in; I'll see them.`,
    ...(button && { button }),
  }
}

/**
 * The domain goes live: the row first, then every pointer written from it
 * (`writePointer` reads the active domain), then what to tell the owner.
 * Null when the claim was removed meanwhile. A retry after the row moved
 * finds it active and writes the pointers again, which repeats what is live.
 */
export async function activateDomain(
  env: Env,
  kit: Tenancy,
  orgId: string,
  domainId: string
): Promise<Say | null> {
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
  if (!done?.slug) return null
  await writePointer(env, kit, orgId, done.row.siteId, done.slug)
  return {
    key: `${domainId}:active`,
    text: `${done.row.primaryHost} is live. ${done.slug} now forwards to it, so links you've shared still work.`,
    button: {
      label: "Open your website",
      action: { kind: "open", url: `https://${done.row.primaryHost}/` },
    },
  }
}

/**
 * The claim fails: after 72 hours without going live, or when its hostname is
 * held elsewhere. The site stays on its slug host, the name is freed, the
 * hostnames are deleted, and what to tell the owner is returned.
 */
export async function expireDomain(
  env: Env,
  kit: Tenancy,
  orgId: string,
  domainId: string,
  reason: "timeout" | "held"
): Promise<Say | null> {
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
  if (!found) return null
  for (const id of Object.values(found.row.cfIds as CfIds)) {
    if (id) await deleteHostname(env, id)
  }
  const where = found.slug ? ` Your site stays on ${found.slug}.` : ""
  const name = found.row.name
  return reason === "held"
    ? {
        key: `${domainId}:failed`,
        text: `I couldn't connect ${name}: it's already set up somewhere else.${where}`,
      }
    : {
        key: `${domainId}:failed`,
        text: `I didn't see the records for ${name} within 3 days, so I've stopped watching.${where} Ask me again any time.`,
        button: {
          label: "Try again",
          action: { kind: "ask", text: `Connect ${name} to my website again.` },
        },
      }
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
 * across orgs, and the unique index says so. A name another org ever held, or
 * whose DNS already reaches us, is a `needs_txt` claim: its hostnames are
 * claimed here and their ownership TXT records added to the answer.
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
  const base = {
    outcome: "connecting" as const,
    method: "records" as const,
    email_affected: false,
    steps: recordsFor({ inspection, apex, hostnames: [], withTxt: false }),
    apex,
    ...(provider && { provider }),
  }
  const pointed = alreadyPointsAtUs(inspection)
  let claimed: Refusal | { id: string; created: boolean; needsTxt: boolean }
  try {
    claimed = await kit.withOrg({ orgId }, async (db) => {
      const [held] = await db
        .select({
          id: domains.id,
          state: domains.state,
          needsTxt: domains.needsTxt,
        })
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
      if (held) return { id: held.id, created: false, needsTxt: held.needsTxt }
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
      const needsTxt = pointed || (await domainHeldElsewhere(db, name))
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
          needsTxt,
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
      return { id: row.id, created: true, needsTxt }
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
  if (claimed.created) {
    // A guarded claim needs its hostnames now, for their TXT; claimed before
    // the Workflow starts so the two never race to create one.
    if (claimed.needsTxt) {
      await claimHostnames(env, kit, orgId, claimed.id).catch(() => {
        // The Workflow claims it with retries; asking again gives the TXT.
      })
    }
    await start(env, orgId, claimed.id)
  }
  const status = claimed.created ? 201 : 200
  if (!claimed.needsTxt)
    return { status, output: ConnectDomainOutput.parse(base) }
  const [row] = await kit.withOrg({ orgId }, (db) =>
    db
      .select({ ownership: domains.ownership })
      .from(domains)
      .where(eq(domains.id, claimed.id))
  )
  const ownership = (row?.ownership ?? {}) as Ownership
  // www first, as the card lists it; jsonb keeps its own key order.
  const txt = [`www.${name}`, name].flatMap((host) => {
    const own = ownership[host]
    return own
      ? [
          {
            type: "TXT" as const,
            name: relative(own.name, name),
            value: own.value,
          },
        ]
      : []
  })
  if (txt.length === 0)
    return refuse(
      503,
      "transient",
      "domain.records_pending",
      "I've started connecting the domain but its records aren't ready yet. Ask me again in a minute."
    )
  return {
    status,
    output: ConnectDomainOutput.parse({
      ...base,
      steps: [...base.steps, ...txt],
    }),
  }
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
  await repoint(env, kit, orgId, found.row.id)
  await revoke(env, found.row)
  try {
    await env.DOMAINS.create({
      id: settleInstanceId(found.row.id),
      params: { org_id: orgId, domain_id: found.row.id, settle: true },
    })
  } catch {
    // Already settling: a repeated removal.
  }
  return null
}

/** A claim's custom hostnames deleted and its Workflow ended; both idempotent. */
async function revoke(env: Env, row: Pick<DomainRow, "id" | "cfIds">) {
  for (const id of Object.values(row.cfIds as CfIds)) {
    if (id) await deleteHostname(env, id)
  }
  try {
    const instance = await env.DOMAINS.get(domainInstanceId(row.id))
    await instance.terminate()
  } catch {
    // Already ended, or never started.
  }
}

/**
 * The pointers once more, from the row as Postgres has it now: an active
 * domain's three are rewritten, a removed one's two are dropped and the slug
 * host pointed back at the site. Anything else has no pointers of its own.
 * Run straight after a state flip and again after `SETTLE`.
 */
export async function repoint(
  env: Env,
  kit: Tenancy,
  orgId: string,
  domainId: string
): Promise<void> {
  const { row, slug } = await kit.withOrg({ orgId }, async (db) => ({
    row: await readDomain(db, domainId),
    slug: await slugHostOf(db, env, orgId),
  }))
  if (!row || !slug) return
  if (row.state === "removed") {
    // Only a domain that went live has pointers; a later live claim on the
    // same name is put back by the `writePointer` below.
    if (row.activatedAt) await dropDomainPointers(env, row.primaryHost, orgId)
  } else if (row.state !== "active") return
  try {
    await writePointer(env, kit, orgId, row.siteId, slug)
  } catch (error) {
    // A closed org keeps no pointer at all; anything else is a failure.
    if ((error as { code?: string }).code !== "org.closed") throw error
  }
}

/**
 * The daily look at an org's live domains, the sweep's domain chunk: the
 * primary host's custom hostname read again. A hostname Cloudflare calls
 * `moved` (its DNS left us) or a certificate no longer active raises one
 * `alert.raised` and returns one message for the owner; one Cloudflare no
 * longer has raises the alert only, since the owner cannot fix it. The check is kept in `last_check` in the same transaction as
 * the alert, so the next sweep finds no change and raises nothing; a domain
 * back to valid is recorded quietly. `hour` keys the message.
 */
export async function sweepDomains(
  env: CloudflareEnv,
  kit: Tenancy,
  orgId: string,
  hour: string
): Promise<Say[]> {
  const rows = await kit.withOrg({ orgId }, (db) =>
    db.select().from(domains).where(eq(domains.state, "active"))
  )
  const says: Say[] = []
  for (const row of rows) {
    const ids = row.cfIds as CfIds
    const id = row.primaryHost === row.name ? ids.apex : ids.www
    if (!id) continue
    const hostname = await getHostname(env, id)
    const check: DomainCheck = !hostname
      ? { status: "not_found" }
      : hostname.status === "moved"
        ? { status: "invalid_configuration" }
        : hostname.ssl?.status !== "active"
          ? { status: "pending_certificate" }
          : { status: "valid" }
    if (JSON.stringify(row.lastCheck) === JSON.stringify(check)) continue
    const before = row.lastCheck === null ? null : JSON.stringify(row.lastCheck)
    const raised = await kit.withOrg({ orgId }, async (db) => {
      const changed = await db
        .update(domains)
        .set({ lastCheck: check })
        .where(
          sql`${domains.id} = ${row.id} and ${domains.state} = 'active' and ${domains.lastCheck} is not distinct from ${before}::jsonb`
        )
        .returning({ id: domains.id })
      if (changed.length === 0 || check.status === "valid") return false
      await appendEvent(db, {
        orgId,
        assignmentId: null,
        staffId: null,
        type: "alert.raised",
        payload: {
          kind: `domain.${check.status}`,
          domain_id: row.id,
          primary_host: row.primaryHost,
        },
      })
      return true
    })
    // A hostname Cloudflare lost is ours to fix: the alert, no message.
    if (!raised || check.status === "not_found") continue
    const primary = row.primaryHost
    const key = `${row.id}:sweep:${hour}`
    if (check.status === "pending_certificate") {
      says.push({
        key,
        text: `The secure certificate for ${primary} isn't active right now, so visitors may see a warning. I'm keeping an eye on it.`,
      })
      continue
    }
    const button = settingsButton(row.provider)
    says.push({
      key,
      text: `${primary} no longer points at your website, so visitors there won't reach it. Point its record back at ${CNAME_TARGET} and it comes back on its own.`,
      ...(button && { button }),
    })
  }
  return says
}

/**
 * Account deletion (ADR-035): every claim the org still holds is removed and
 * its custom hostnames deleted. The takedown route clears the pointers
 * first, while the active row still names them; a closed org gets none back.
 */
export async function revokeDomains(
  env: Env,
  kit: Tenancy,
  orgId: string
): Promise<void> {
  const held = await kit.withOrg({ orgId }, (db) =>
    db
      .select({ id: domains.id, cfIds: domains.cfIds })
      .from(domains)
      .where(sql`${domains.state} <> 'removed'`)
  )
  // The hostnames before the rows, so a retried takedown still finds them.
  // Failed claims are included: their hostnames are deleted again, idempotently.
  for (const row of held) await revoke(env, row)
  await kit.withOrg({ orgId }, (db) =>
    db
      .update(domains)
      .set({ state: "removed", removedAt: new Date() })
      .where(sql`${domains.state} <> 'removed'`)
  )
}
