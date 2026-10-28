import {
  CheckDomainOutput,
  ConnectDomainOutput,
  type DnsRecord,
  DomainCheck,
  DomainInspection,
  DomainName,
  DomainProvider,
  type DomainRegistration,
  type DomainState,
  type ServerButton,
  SITE_HEADER,
  siteHost,
} from "@workspace/contracts"
import {
  appendEvent,
  domainHeldElsewhere,
  domains,
  eq,
  failureCode,
  listOrgIds,
  type OrgScopedDb,
  orgs,
  pgCode,
  postAssistantMessage,
  type SQL,
  sql,
  syncTasks,
  type Tenancy,
  tenancy,
} from "@workspace/db"
import { canonical } from "@workspace/facade"
import { z } from "zod"
import { applyUrl } from "./domain-connect.ts"
import {
  alreadyPointsAtUs,
  apexMode,
  applyBase,
  CAA_FOR_US,
  type CloudflareEnv,
  CNAME_TARGET,
  type CustomHostname,
  claimHosts,
  DomainError,
  deleteHostname,
  detectProvider,
  domainCheck,
  ensureHostname,
  getHostname,
  hasTxt,
  type Inspection,
  inspect,
  OUR_ZONE,
  type RouteEnv,
  recordsFor,
  refreshHostname,
  relative,
  setRoutes,
  stillToAdd,
  zoneApex,
} from "./domains.ts"
import { writeUpdate } from "./heartbeat-write.ts"
import type { Observed } from "./probe.ts"
import {
  activeDeployment,
  dropDomainPointers,
  otherHost,
  writePointer,
} from "./publish.ts"
import { rdapLookup } from "./rdap.ts"
import {
  detachHostname,
  getRegistration,
  type RegistrarEnv,
  setAutoRenew,
} from "./registrar.ts"
import { forgetHost } from "./search.ts"
import { moveGoogle } from "./search-start.ts"
import { cancelRenewal } from "./stripe.ts"

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
export type DomainParams = {
  org_id: string
  domain_id: string
  settle?: true
  /** A purchase: wait for the payment, register, capture, serve. */
  buy?: true
}
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
 * after the last time it moved, so an owner who is making progress is not
 * nagged.
 */
export const NUDGE_AFTER_MS = 24 * 60 * 60 * 1000
const MINUTE = 60 * 1000
/**
 * How long a look waits for a `check` nudge before looking again, by how long
 * the claim has been connecting: every minute for the first half hour, while
 * the owner adds records and Cloudflare answers within minutes (measured
 * 2026-10-16: hostname active at 43 s, certificate at 2 min 8 s), every 10
 * minutes to two hours, then hourly. By the clock, not the look count, so a
 * nudge never moves the schedule on: about 110 looks over 72 hours.
 */
export const nextWait = (elapsedMs: number) =>
  elapsedMs < 30 * MINUTE
    ? MINUTE
    : elapsedMs < 120 * MINUTE
      ? 10 * MINUTE
      : 60 * MINUTE

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

/** The newest claim `where` picks, with its org's slug host, in one read. */
export async function readClaim(
  db: OrgScopedDb,
  env: Pick<Env, "SITE_HOST_SUFFIX">,
  where: SQL
) {
  const [found] = await db
    .select({ row: domains, slug: orgs.slug })
    .from(domains)
    .innerJoin(orgs, eq(orgs.id, domains.orgId))
    .where(where)
    .orderBy(sql`${domains.createdAt} desc`)
    .limit(1)
  return found
    ? { row: found.row, slug: siteHost(found.slug, env.SITE_HOST_SUFFIX) }
    : undefined
}

/**
 * The claim moved to `to` with its event, only from a state in `from`. The
 * update names those states rather than trusting the read before it, so a
 * write that committed in between wins: an activation that lost to a
 * removal moves nothing and gets false.
 */
export async function moveTo(
  db: OrgScopedDb,
  row: DomainRow,
  to: DomainState,
  from: readonly DomainState[],
  set: Partial<DomainRow>,
  event: { type: string; payload: Record<string, unknown> }
): Promise<boolean> {
  const moved = await db
    .update(domains)
    .set({ ...set, state: to })
    .where(
      sql`${domains.id} = ${row.id} and ${domains.state} in (${sql.join(
        from.map((state) => sql`${state}`),
        sql`, `
      )})`
    )
    .returning({ id: domains.id })
  if (moved.length === 0) return false
  await appendEvent(db, {
    orgId: row.orgId,
    assignmentId: null,
    staffId: null,
    ...event,
  })
  await syncTasks(db, row.orgId)
  return true
}

/**
 * A claim's custom hostnames deleted with their staging routes, and a bought
 * domain's Workers Custom Domains; one already gone is done. A bought zone
 * stays: the domain is the owner's.
 */
async function dropHostnames(
  env: RouteEnv & RegistrarEnv,
  row: Pick<DomainRow, "name" | "cfIds">
) {
  const ids = row.cfIds as CfIds & {
    worker_apex?: string
    worker_www?: string
  }
  await setRoutes(env, claimHosts(row.name, ids), false)
  for (const id of [ids.apex, ids.www]) {
    if (id) await deleteHostname(env, id)
  }
  for (const id of [ids.worker_apex, ids.worker_www]) {
    if (id) await detachHostname(env, id)
  }
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
export async function eventKey(
  key: string,
  kind = "domain.status"
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${kind}:${key}`)
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
      // A subdomain's own record is named relative to its zone, so it is `name` itself.
      const host =
        first.name === "@" || name.startsWith(`${first.name}.`)
          ? name
          : `${first.name}.${name}`
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
function nextStep(
  state: DomainState,
  check: DomainCheck,
  name: string,
  primary: string
) {
  if (state === "active") return `${name} is live. Nothing to do.`
  if (state === "failed")
    return `Connecting ${name} timed out. Offer to try again.`
  if (state === "removed")
    return `${name} was removed. Offer to connect it again.`
  return (
    statusText(check, name, primary) ??
    "Nothing to do: the records are not there yet and I'm watching for them."
  )
}

/**
 * Whether a host answers through our edge with a certificate: anything short
 * of a 5xx. The certificate's proof alone, for a domain not yet active: the
 * router has no site for it until `activateDomain`, so it answers 404 here.
 */
export async function answers(host: string): Promise<boolean> {
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
 * Whether `host` serves this site: a 2xx after redirects that the router
 * marked with the site's id. The router's own 404 and any other server fail.
 * Every "it is live" is said on this, run when it is said.
 */
export async function reaches(host: string, siteId: string): Promise<boolean> {
  try {
    const response = await fetch(`https://${host}/`, {
      signal: AbortSignal.timeout(10_000),
    })
    await response.body?.cancel()
    return response.ok && response.headers.get(SITE_HEADER) === siteId
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

/** The ownership TXT records a card lists, `www` first, named relative to the zone's apex. */
function txtRecords(
  ownership: Ownership,
  name: string,
  apex: string
): DnsRecord[] {
  return [`www.${name}`, name].flatMap((host) => {
    const own = ownership[host]
    return own
      ? [
          {
            type: "TXT" as const,
            name: relative(own.name, apex),
            value: own.value,
          },
        ]
      : []
  })
}

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
 * `unknown_error`, which the Workflow looks past. Before any hostname exists
 * the check is `not_found` whatever DNS says, so DNS is not read. `txtMissing`
 * is the guard below holding a domain whose records are otherwise in, and
 * `apex` the zone the owner's DNS page is for. `refresh` asks Cloudflare to
 * validate a hostname not yet active now, for when the records may just
 * have gone in.
 */
export async function currentCheck(
  env: CloudflareEnv,
  row: Pick<
    DomainRow,
    "name" | "cfIds" | "primaryHost" | "needsTxt" | "ownership"
  >,
  refresh?: boolean
): Promise<{
  check: DomainCheck
  primary: string
  apex?: string
  txtMissing?: true
}> {
  const ids = row.cfIds as CfIds
  if (!ids.apex && !ids.www)
    return { check: { status: "not_found" }, primary: row.primaryHost }
  const read = async (id: string | undefined) => {
    const hostname = id ? await getHostname(env, id) : null
    return hostname && refresh ? refreshHostname(env, hostname) : hostname
  }
  try {
    const [inspection, apex, www] = await Promise.all([
      inspect(row.name),
      read(ids.apex),
      read(ids.www),
    ])
    const wwwHost = `www.${row.name}`
    // A subdomain is served on its own name, its hostname kept as `apex`.
    const alias = !!inspection.sub || apexMode(inspection, apex) === "alias"
    const hosts: Array<{ host: string; hostname: CustomHostname | null }> =
      inspection.sub
        ? [{ host: row.name, hostname: apex }]
        : [
            ...(alias ? [{ host: row.name, hostname: apex }] : []),
            { host: wwwHost, hostname: www },
          ]
    let check = domainCheck(inspection, hosts)
    // The takeover guard: a name another org held, or one that pointed at us
    // before this claim, is not verified until each host's ownership TXT is
    // in public DNS. Cloudflare's own `active` may come from the CNAME alone.
    let txtMissing = false
    if (
      row.needsTxt &&
      PAST_VERIFICATION.includes(check.status) &&
      !(await ownedByTxt(row.ownership as Ownership, hosts))
    ) {
      check = { status: "pending_verification" }
      txtMissing = true
    }
    return {
      check,
      primary: alias ? row.name : wwwHost,
      apex: inspection.apex,
      ...(txtMissing && { txtMissing }),
    }
  } catch {
    return { check: { status: "unknown_error" }, primary: row.primaryHost }
  }
}

// ---------------------------------------------------------------------------
// Workflow steps
// ---------------------------------------------------------------------------

/**
 * The claim's custom hostnames, the apex and `www`, or a subdomain's one
 * (kept as `apex`), created or found and
 * kept in `cf_ids`, with each one's ownership TXT in `ownership`. Each id is stored as soon as its hostname exists, so a
 * retry after the second create fails still owns the first. `gone` for a
 * claim no longer connecting, `held` when Cloudflare has a hostname this
 * claim does not own. `sub` is whether the name is a subdomain, when the
 * caller has just read its zone.
 */
export async function claimHostnames(
  env: Env,
  kit: Tenancy,
  orgId: string,
  domainId: string,
  sub?: boolean
): Promise<"gone" | "held" | { ids: CfIds; ownership: Ownership }> {
  const row = await kit.withOrg({ orgId }, (db) => readDomain(db, domainId))
  if (!row || !connecting(row.state)) return "gone"
  const ids = { ...(row.cfIds as CfIds) }
  const ownership = { ...(row.ownership as Ownership) }
  sub ??= (await zoneApex(row.name)).apex !== row.name
  const hosts = [
    ...(sub ? [] : [["www", `www.${row.name}`] as const]),
    ["apex", row.name] as const,
  ]
  for (const [key, host] of hosts) {
    const before = canonical([ids, ownership])
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
    // A hostname this claim already held and stored needs no write.
    if (canonical([ids, ownership]) === before) continue
    await kit.withOrg({ orgId }, (db) =>
      db
        .update(domains)
        .set({ cfIds: ids, ownership })
        .where(eq(domains.id, domainId))
    )
  }
  await setRoutes(env, claimHosts(row.name, ids), true)
  return { ids, ownership }
}

export type Seen =
  | { gone: true }
  | {
      gone: false
      at: number
      status: DomainCheck["status"]
      ready: boolean
      /** The row moved on this look: the owner's quiet period starts over. */
      changed?: boolean
      /** What to tell the owner, which the probe adds when the check changed. */
      say?: Say
    }

/**
 * One look, the `look` probe: the check, the row brought up to date, and the
 * reading the probe hashes. Ready means valid and answering through our edge.
 * The message is worded here and said by the probe only when the check
 * differs from the last one the task step holds. `refresh` as `currentCheck`.
 */
export async function look(
  env: Env,
  kit: Tenancy,
  orgId: string,
  domainId: string,
  refresh?: boolean
): Promise<Observed<Seen>> {
  const row = await kit.withOrg({ orgId }, (db) => readDomain(db, domainId))
  if (!row || !connecting(row.state)) return { result: { gone: true } }
  const seen = await currentCheck(env, row, refresh)
  let check = seen.check
  const ready = check.status === "valid" && (await answers(seen.primary))
  // Valid at Cloudflare but not yet answering: the certificate is still deploying.
  if (check.status === "valid" && !ready)
    check = { status: "pending_certificate" }
  const result = {
    gone: false as const,
    at: Date.now(),
    status: check.status,
    ready,
  }
  // A failed read is no news: nothing stored moves, and the next look reads again.
  if (check.status === "unknown_error") return { result }
  // jsonb keeps keys in its own order, so the stored check is compared canonically.
  const same = canonical(row.lastCheck) === canonical(check)
  const provider = DomainProvider.safeParse(row.provider)
  const where = provider.success ? provider.data.name : "your DNS provider"
  // Records in, ownership TXT not: the owner's one step left is the TXT.
  const txt =
    seen.txtMissing && seen.apex
      ? txtRecords(row.ownership as Ownership, row.name, seen.apex)
      : []
  const text =
    txt.length > 0
      ? `Your records for ${seen.primary} are in. One more thing, so I know the domain is yours: add ${txt.length === 1 ? "this TXT record" : "these TXT records"} at ${where}: ${txt.map((r) => `${r.name} = ${r.value}`).join("; ")}. Your email isn't affected.`
      : statusText(check, row.name, seen.primary)
  const button =
    txt.length > 0 ||
    check.status === "conflicting_record" ||
    check.status === "invalid_configuration"
      ? settingsButton(row.provider)
      : undefined
  const state: DomainState =
    txt.length > 0 ||
    check.status === "pending_certificate" ||
    check.status === "valid"
      ? "verifying"
      : "awaiting_dns"
  const changed =
    !same || state !== row.state || seen.primary !== row.primaryHost
  // A quiet look writes nothing; a removal since the read is the next look's.
  if (changed) {
    const updated = await kit.withOrg({ orgId }, async (db) => {
      const moved = await db
        .update(domains)
        .set({ lastCheck: check, state, primaryHost: seen.primary })
        .where(
          sql`${domains.id} = ${domainId} and ${domains.state} in ('awaiting_dns', 'verifying')`
        )
        .returning({ id: domains.id })
      if (moved.length > 0) await syncTasks(db, orgId)
      return moved
    })
    if (updated.length === 0) return { result: { gone: true } }
  }
  // Until the records are seen the owner is the one to act; past them, Cloudflare is.
  const waiting = state === "awaiting_dns"
  const [conflict] =
    check.status === "conflicting_record" ? check.conflicts : []
  return {
    result: { ...result, changed },
    reading: {
      step: txt.length > 0 ? "ownership" : waiting ? "records" : "certificate",
      // The claim's id, so a new claim on the same task is news again.
      evidence: {
        domain_id: domainId,
        check,
        host: seen.primary,
        ...(txt.length > 0 && { txt: true }),
      },
      ...((waiting || txt.length > 0) && {
        write: {
          state: "blocked",
          blocked_on: "owner_action",
          note:
            txt.length > 0
              ? `Add the TXT record${txt.length > 1 ? "s" : ""} at ${where}`
              : conflict
                ? `Delete the old ${conflict.type} record at ${where}`
                : `Add the records at ${where}`,
        },
      }),
      ...(text && { tell: async () => ({ text, ...(button && { button }) }) }),
    },
  }
}

/**
 * The reminder for a claim quiet since `since`, once per quiet period, with
 * where the owner's DNS settings are. This line, the live one and the failed
 * ones are worded by the model from their facts, or else are the template
 * (heartbeat-write.ts); `statusText`'s DNS records stay fixed.
 */
export async function nudge(
  env: { OPENROUTER_API_KEY?: string },
  kit: Tenancy,
  orgId: string,
  domainId: string,
  since: number
): Promise<Say | null> {
  const row = await kit.withOrg({ orgId }, (db) => readDomain(db, domainId))
  if (!row || !connecting(row.state)) return null
  const provider = DomainProvider.safeParse(row.provider)
  const where = provider.success
    ? ` Your domain's settings are at ${provider.data.name}.`
    : ""
  const button = settingsButton(row.provider)
  return {
    key: `${domainId}:nudge:${since}`,
    text: await writeUpdate(env, kit, orgId, {
      facts: {
        domain: row.name,
        ...(provider.success && { provider: provider.data.name }),
      },
      template: `I'm still waiting for the records for ${row.name}.${where} There's no need to tell me when they're in; I'll see them.`,
    }),
    ...(button && { button }),
  }
}

/**
 * The domain goes live: the row first, then every pointer written from it
 * (`writePointer` reads the active domain). False when the claim was removed
 * meanwhile. A retry after the row moved finds it active and writes the
 * pointers again, which repeats what is live. Saying so waits for `served`.
 */
export async function activateDomain(
  env: Env,
  kit: Tenancy,
  orgId: string,
  domainId: string
): Promise<boolean> {
  const done = await kit.withOrg({ orgId }, async (db) => {
    const claim = await readClaim(db, env, eq(domains.id, domainId))
    if (!claim) return null
    const { row } = claim
    if (row.state === "active") return claim
    const moved = await moveTo(
      db,
      row,
      "active",
      CONNECTING,
      { activatedAt: new Date() },
      {
        type: "domain.activated",
        payload: { domain_id: domainId, primary_host: row.primaryHost },
      }
    )
    if (!moved) return null
    return claim
  })
  if (!done) return false
  await writePointer(env, kit, orgId, done.row.siteId, done.slug)
  await setRoutes(env, claimHosts(done.row.name, done.row.cfIds as CfIds), true)
  return true
}

export type Served =
  | { gone: true }
  | { gone: false; at: number; ready: boolean; say?: Say }

/**
 * The `loads` probe after activation: whether the domain serves this site,
 * on a fresh request (`reaches`). Until KV carries the pointer, up to a
 * minute, the router answers 404. Live is worded only once it passes.
 */
export async function served(
  env: Env,
  kit: Tenancy,
  orgId: string,
  domainId: string
): Promise<Observed<Served>> {
  const claim = await kit.withOrg({ orgId }, (db) =>
    readClaim(db, env, eq(domains.id, domainId))
  )
  if (claim?.row.state !== "active") return { result: { gone: true } }
  const { row, slug } = claim
  const ready = await reaches(row.primaryHost, row.siteId)
  // Serving is the proof Google is moved on: the new host added, the old one let go.
  const google = ready ? await moveGoogle(env, kit, orgId, slug) : null
  const gsc = "Google Search Console"
  return {
    result: { gone: false, at: Date.now(), ready },
    reading: {
      step: "loads",
      evidence: { domain_id: domainId, host: row.primaryHost, ready },
      // Only this proof makes `loads` done; the rows keep it in progress.
      ...(ready && {
        write: { state: "done" },
        tell: async () => ({
          text: await writeUpdate(env, kit, orgId, {
            facts: {
              host: row.primaryHost,
              old_host: slug,
              ...(google && { google: gsc }),
            },
            template: `${row.primaryHost} is live. ${slug} now forwards to it, so links you've shared still work.${
              google === "moved"
                ? ` I'm adding it to your ${gsc} and taking ${slug} out of it.`
                : google
                  ? ` I'm adding it to your ${gsc} too.`
                  : ""
            }`,
          }),
          button: {
            label: "Open your website",
            action: { kind: "open", url: `https://${row.primaryHost}/` },
          },
        }),
      }),
    },
  }
}

/**
 * Active in our records but not serving the site by the deadline: only we can
 * fix that, so an alert, and the owner told once.
 */
export async function notServed(
  kit: Tenancy,
  orgId: string,
  domainId: string
): Promise<Say | null> {
  return kit.withOrg({ orgId }, async (db) => {
    const row = await readDomain(db, domainId)
    if (row?.state !== "active") return null
    await appendEvent(db, {
      orgId,
      assignmentId: null,
      staffId: null,
      type: "alert.raised",
      payload: { kind: "domain.serve_failed", domain_id: domainId },
    })
    return {
      key: `${domainId}:not_served`,
      text: `${row.primaryHost} is connected, but your site isn't loading there yet. I've flagged it so we can fix it.`,
    }
  })
}

/**
 * The claim fails: after 72 hours without going live, or when its hostname is
 * held elsewhere. The site stays on its slug host, the name is freed, the
 * hostnames are deleted, and what to tell the owner is returned.
 */
export async function expireDomain(
  env: RouteEnv &
    Pick<Env, "SITE_HOST_SUFFIX"> & { OPENROUTER_API_KEY?: string },
  kit: Tenancy,
  orgId: string,
  domainId: string,
  reason: "timeout" | "held"
): Promise<Say | null> {
  const found = await kit.withOrg({ orgId }, async (db) => {
    const claim = await readClaim(db, env, eq(domains.id, domainId))
    if (!claim) return null
    return claim.row.state === "failed" ||
      (await moveTo(
        db,
        claim.row,
        "failed",
        CONNECTING,
        {},
        { type: "domain.failed", payload: { domain_id: domainId, reason } }
      ))
      ? claim
      : null
  })
  if (!found) return null
  await dropHostnames(env, found.row)
  const where = ` Your site stays on ${found.slug}.`
  const name = found.row.name
  const facts = { domain: name, site: found.slug }
  return reason === "held"
    ? {
        key: `${domainId}:failed`,
        text: await writeUpdate(env, kit, orgId, {
          facts,
          template: `I couldn't connect ${name}: it's already set up somewhere else.${where}`,
        }),
      }
    : {
        key: `${domainId}:failed`,
        text: await writeUpdate(env, kit, orgId, {
          facts: { ...facts, days: "3" },
          template: `I didn't see the records for ${name} within 3 days, so I've stopped watching.${where} Ask me again any time.`,
        }),
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
export const refuse = (
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
    "That isn't a domain we can connect: give the address itself, like sparkleclean.co.uk or book.sparkleclean.co.uk."
  )

/**
 * `GET /domains/{name}/inspect`: what a name the owner already has is, before
 * anything is connected. Whether it is registered and with whom comes from
 * RDAP; a registry that is down or rate-limiting leaves DNS to say whether
 * the name exists, and the registrar unknown. Then who runs its DNS (the
 * connect card's detection) and whether it already points somewhere.
 */
export async function inspectDomain(
  raw: unknown
): Promise<Refusal | DomainInspection> {
  const name = normalizeName(raw)
  if (!name) return invalid()
  const known = await rdapLookup(name).catch(() => null)
  if (known && !known.registered)
    return { name, registered: false, in_use: false }
  let inspection: Inspection | null = null
  try {
    inspection = await inspect(name)
  } catch (error) {
    if (!(error instanceof DomainError && error.name === "domain.not_found"))
      return refuse(
        503,
        "transient",
        "dns.unavailable",
        "I couldn't read the domain's DNS just now. Try again in a minute."
      )
  }
  const dnsHost =
    inspection &&
    (await detectProvider(inspection.apex, inspection.nameservers))
  return DomainInspection.parse({
    name,
    registered: known?.registered ?? inspection !== null,
    ...(known?.registrar && { registrar: known.registrar }),
    ...(dnsHost && { dns_host: dnsHost }),
    in_use: Object.values(inspection?.hosts ?? {}).some(
      (h) => h.cname || h.a.length + h.aaaa.length > 0
    ),
  })
}

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
  body: { name?: unknown; approval_id?: unknown; conversation_id?: unknown }
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
  // A subdomain one level below its zone apex, like `book.x.co.uk`; no deeper.
  if (inspection.sub && relative(inspection.sub, inspection.apex).includes("."))
    return invalid()
  const provider = await detectProvider(inspection.apex, inspection.nameservers)
  const apex = apexMode(inspection, null)
  const base = {
    outcome: "connecting" as const,
    method: "records" as const,
    email_affected: false,
    steps: stillToAdd(recordsFor({ inspection, apex }), inspection),
    // A subdomain has no bare-address choice.
    ...(!inspection.sub && { apex }),
    ...(provider && { provider }),
  }
  const pointed = alreadyPointsAtUs(inspection)
  let claimed:
    | Refusal
    | { id: string; created: boolean; needsTxt: boolean; ownership: unknown }
  try {
    claimed = await kit.withOrg({ orgId }, async (db) => {
      // One connect per org at a time, so two cannot both count 2 pending and
      // insert. Key 4: 2 and 3 are the api's conversation and org locks.
      await db.execute(
        sql`select pg_advisory_xact_lock(4, hashtext(${orgId}::text))`
      )
      const [held] = await db
        .select({
          id: domains.id,
          state: domains.state,
          needsTxt: domains.needsTxt,
          ownership: domains.ownership,
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
      if (held) return { ...held, created: false }
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
        .where(
          sql`${domains.state} in ('awaiting_dns', 'verifying') and ${domains.origin} = 'connected'`
        )
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
          primaryHost:
            inspection.sub || apex === "alias" ? name : `www.${name}`,
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
      return { id: row.id, created: true, needsTxt, ownership: {} }
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
  let ownership = claimed.ownership as Ownership
  if (claimed.created) {
    // A guarded claim needs its hostnames now, for their TXT; claimed before
    // the Workflow starts so the two never race to create one.
    if (claimed.needsTxt) {
      const made = await claimHostnames(
        env,
        kit,
        orgId,
        claimed.id,
        !!inspection.sub
      ).catch(() => null)
      // A failure here is the Workflow's to retry; asking again gives the TXT.
      if (made && typeof made === "object") ownership = made.ownership
    }
    await start(env, orgId, claimed.id)
  }
  const status: 200 | 201 = claimed.created ? 201 : 200
  // The task keeps how many changes the card lists, which no row holds.
  const answer = async (
    steps: typeof base.steps,
    link?: { method: "domain_connect"; apply_url: string }
  ) => {
    const changes = steps.length + ("apex" in base ? 1 : 0)
    await kit.withOrg({ orgId }, (db) => syncTasks(db, orgId, { changes }))
    return {
      status,
      output: ConnectDomainOutput.parse({ ...base, steps, ...link }),
    }
  }
  if (!claimed.needsTxt) {
    const link = await applyLink(env, inspection, base.steps, name, body)
    return answer(
      base.steps,
      link ? { method: "domain_connect", apply_url: link } : undefined
    )
  }
  const txt = txtRecords(ownership, name, inspection.apex)
  if (txt.length === 0)
    return refuse(
      503,
      "transient",
      "domain.records_pending",
      "I've started connecting the domain but its records aren't ready yet. Ask me again in a minute."
    )
  return answer([...base.steps, ...txt])
}

/**
 * The provider's signed Domain Connect page that adds the owner's one CNAME
 * for them, or undefined. Only for a claim whose records are that CNAME
 * alone: our template holds no ALIAS, CAA or TXT, and a page that left one
 * out would read as done when it is not. The owner's tab comes back to the
 * web's `/api/domains/applied`, which runs the check and opens `conversation_id`.
 */
export async function applyLink(
  env: Env,
  inspection: Inspection,
  steps: DnsRecord[],
  name: string,
  body: { conversation_id?: unknown }
): Promise<string | undefined> {
  const conversation = z.uuid().safeParse(body.conversation_id)
  const [step, ...more] = steps
  if (!env.DOMAIN_CONNECT_KEY || !conversation.success) return undefined
  if (step?.type !== "CNAME" || more.length > 0) return undefined
  const syncUX = await applyBase(inspection.apex)
  if (!syncUX) return undefined
  const back = new URL("/api/domains/applied", env.APP_ORIGIN)
  back.searchParams.set("name", name)
  back.searchParams.set("c", conversation.data)
  return applyUrl(syncUX, env.DOMAIN_CONNECT_KEY, {
    domain: inspection.apex,
    host: step.name,
    redirect_uri: back.href,
  })
}

/** The claim's Workflow, created; one already there is fine. */
export async function start(
  env: Env,
  orgId: string,
  domainId: string,
  buy?: true
) {
  try {
    await env.DOMAINS.create({
      id: domainInstanceId(domainId),
      params: { org_id: orgId, domain_id: domainId, ...(buy && { buy }) },
    })
  } catch {
    // Already created: the id is the claim's.
  }
}

/**
 * `POST /domains/{name}/check`: the check now, for a claim still connecting,
 * and a nudge so its Workflow looks too; the stored state for any other. A
 * Workflow that cannot take the nudge is created again, which recovers a
 * claim whose create failed after the row was written. `refresh` is off for
 * Cloudflare's own certificate events, which a refresh would only repeat.
 */
export async function checkNow(
  env: Env,
  kit: Tenancy,
  orgId: string,
  rawName: string,
  refresh = true
): Promise<Refusal | CheckDomainOutput> {
  const name = normalizeName(rawName)
  if (!name) return invalid()
  // The org's newest row for the name, removed ones included.
  const row = (
    await kit.withOrg({ orgId }, (db) =>
      readClaim(db, env, eq(domains.name, name))
    )
  )?.row
  if (!row)
    return refuse(
      404,
      "resource",
      "domain.not_found",
      `${name} isn't connected to this site.`
    )
  let status: DomainCheck
  if (connecting(row.state)) {
    // The owner says the records are in: Cloudflare validates now, not on its backoff.
    status = (await currentCheck(env, row, refresh)).check
    // Valid at Cloudflare is not live: only the Workflow's activation is, as in `look`.
    if (status.status === "valid") status = { status: "pending_certificate" }
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
    next_step: nextStep(row.state, status, name, row.primaryHost),
  })
}

/**
 * `DELETE /domains/{name}`: the row first, so no look can activate it again;
 * then, for a live domain, its two pointers and the slug host pointed back at
 * the site; then the hostnames, the Workflow and the hosts' Search Console
 * verification. A repeat finds the row
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
    const claim = await readClaim(db, env, eq(domains.name, name))
    // A purchase being paid for or registered holds money: it finishes first.
    if (
      claim?.row.origin === "purchased" &&
      ["awaiting_payment", "verifying"].includes(claim.row.state)
    )
      return "buying" as const
    // From any state, so a removal racing an activation still removes it.
    if (claim)
      await moveTo(
        db,
        claim.row,
        "removed",
        ["awaiting_dns", "verifying", "active", "failed"],
        { removedAt: new Date() },
        {
          type: "domain.removed",
          payload: { domain_id: claim.row.id, was: claim.row.state },
        }
      )
    return claim
  })
  if (found === "buying")
    return refuse(
      409,
      "resource",
      "domain.purchase_in_progress",
      `${name} is still being bought. Remove it once it's live.`
    )
  if (!found)
    return refuse(
      404,
      "resource",
      "domain.not_found",
      `${name} isn't connected to this site.`
    )
  await stopServing(env, kit, orgId, found.row)
  return null
}

/**
 * A claim that has left `active` stops being served: its pointers rewritten
 * from the row, its hostnames and billing revoked, its Google files
 * forgotten, and the pointers written once more after `SETTLE`. Idempotent.
 * A removal and a lapsed registration share it.
 */
async function stopServing(
  env: Env,
  kit: Tenancy,
  orgId: string,
  row: DomainRow
) {
  await repoint(env, kit, orgId, row.id)
  await revoke(env, row)
  // This org's Google files must not prove the name for whoever claims it next.
  for (const host of [row.primaryHost, otherHost(row.primaryHost)]) {
    await forgetHost(env, kit, orgId, host)
  }
  try {
    await env.DOMAINS.create({
      id: settleInstanceId(row.id),
      params: { org_id: orgId, domain_id: row.id, settle: true },
    })
  } catch {
    // Already settling: a repeated removal.
  }
}

/**
 * A bought domain past its stored expiry, asked of the registrar, which knows
 * if it renewed: a later date is kept, and none or a past one means it
 * lapsed. A lapsed domain leaves `active` and stops being served, as a
 * removal does, and the owner is told. Cleanup that fails after the row moved
 * raises an alert, since the sweep will not find the row again.
 */
async function lapse(
  env: Env,
  kit: Tenancy,
  orgId: string,
  row: DomainRow
): Promise<Say | null> {
  const registration = row.registration as DomainRegistration | null
  const expiry = registration?.expires_at
  if (!(registration && expiry) || Date.parse(expiry) > Date.now()) return null
  const live = await getRegistration(env, row.name)
  if (live?.expires_at && Date.parse(live.expires_at) > Date.now()) {
    const renewed = { ...registration, expires_at: live.expires_at }
    await kit.withOrg({ orgId }, (db) =>
      db
        .update(domains)
        .set({ registration: renewed })
        .where(eq(domains.id, row.id))
    )
    return null
  }
  const found = await kit.withOrg({ orgId }, async (db) => {
    const claim = await readClaim(db, env, eq(domains.id, row.id))
    return claim &&
      (await moveTo(
        db,
        claim.row,
        "removed",
        ["active"],
        { removedAt: new Date() },
        { type: "domain.expired", payload: { domain_id: row.id } }
      ))
      ? claim
      : null
  })
  if (!found) return null
  try {
    await stopServing(env, kit, orgId, found.row)
  } catch (error) {
    await kit.withOrg({ orgId }, (db) =>
      appendEvent(db, {
        orgId,
        assignmentId: null,
        staffId: null,
        type: "alert.raised",
        payload: {
          kind: "domain.expiry_cleanup_failed",
          domain_id: row.id,
          code: failureCode(error),
        },
      })
    )
  }
  return {
    key: `${row.id}:lapsed`,
    text: `${row.name} wasn't renewed and has run out, so visitors there no longer reach your website. It's back at ${found.slug}. If you still want ${row.name}, I can buy it again.`,
    button: {
      label: "Buy it again",
      action: { kind: "pay", name: row.name },
    },
  }
}

/**
 * A claim's custom hostnames deleted, its Workflow ended and, for a bought
 * domain, its renewal stopped on both sides: Stripe bills the owner nothing
 * more and Cloudflare bills us nothing more. All idempotent. Billing goes
 * last, so a Stripe failure never leaves a hostname serving.
 */
async function revoke(
  env: Env,
  row: Pick<DomainRow, "id" | "name" | "cfIds" | "stripe">
) {
  await dropHostnames(env, row)
  try {
    const instance = await env.DOMAINS.get(domainInstanceId(row.id))
    await instance.terminate()
  } catch {
    // Already ended, or never started.
  }
  // A subscription exists only once the domain was registered and paid for.
  const sub = (row.stripe as { subscription?: string } | null)?.subscription
  if (sub) {
    await cancelRenewal(env, sub)
    await setAutoRenew(env, row.name, false)
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
  const claim = await kit.withOrg({ orgId }, (db) =>
    readClaim(db, env, eq(domains.id, domainId))
  )
  if (!claim) return
  const { row, slug } = claim
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
 *
 * A claim still connecting an hour past its deadline is one its Workflow
 * never ended (a create that failed, an instance that errored), and fails
 * here as it would there, so the 72-hour bound holds without the Workflow.
 */
export async function sweepDomains(
  env: Env,
  kit: Tenancy,
  orgId: string,
  hour: string
): Promise<Say[]> {
  const stale = new Date(Date.now() - DEADLINE_MS - 60 * MINUTE).toISOString()
  const rows = await kit.withOrg({ orgId }, (db) =>
    db
      .select()
      .from(domains)
      .where(
        sql`${domains.state} = 'active' or (${domains.state} in ('awaiting_dns', 'verifying') and ${domains.origin} = 'connected' and ${domains.createdAt} < ${stale}::timestamptz)`
      )
  )
  const says: Say[] = []
  for (const row of rows) {
    if (connecting(row.state)) {
      const say = await expireDomain(env, kit, orgId, row.id, "timeout")
      if (say) says.push(say)
      continue
    }
    // A bought domain has no custom hostname to read; its registration is the check.
    if (row.origin === "purchased") {
      const say = await lapse(env, kit, orgId, row)
      if (say) says.push(say)
      continue
    }
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
    if (canonical(row.lastCheck) === canonical(check)) continue
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
 * Staging's routes put back for every claim this environment holds that is
 * connecting or live, across orgs: each staging deploy of the router replaces
 * its routes with its config's, which has none of these. Run after that
 * deploy and hourly. Without `CF_ROUTE_SCRIPT` (production) it reads nothing.
 */
export async function restoreRoutes(
  env: Env
): Promise<{ hosts: number; ok: boolean }> {
  if (!env.CF_ROUTE_SCRIPT) return { hosts: 0, ok: true }
  const hosts = await withKit(env, async (kit) => {
    const all: string[] = []
    for (const orgId of await listOrgIds(kit)) {
      const rows = await kit.withOrg({ orgId }, (db) =>
        db
          .select({ name: domains.name, cfIds: domains.cfIds })
          .from(domains)
          .where(
            sql`${domains.state} in ('awaiting_dns', 'verifying', 'active')`
          )
      )
      for (const row of rows)
        all.push(...claimHosts(row.name, row.cfIds as CfIds))
    }
    return all
  })
  return { hosts: hosts.length, ok: await setRoutes(env, hosts, true) }
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
  // A purchase that is paid for and registering holds the owner's money:
  // its Workflow finishes it (capture or release) and the row is left alone.
  // shortcut: such a purchase then stays `verifying` on a closed org, its
  // activation refused; settle it by hand if a takedown ever lands mid-purchase.
  const kept = sql`${domains.state} <> 'removed' and not (${domains.origin} = 'purchased' and ${domains.state} = 'verifying')`
  const held = await kit.withOrg({ orgId }, (db) =>
    db
      .select({
        id: domains.id,
        name: domains.name,
        cfIds: domains.cfIds,
        stripe: domains.stripe,
      })
      .from(domains)
      .where(kept)
  )
  // The hostnames before the rows, so a retried takedown still finds them.
  // Failed claims are included: their hostnames are deleted again, idempotently.
  for (const row of held) await revoke(env, row)
  await kit.withOrg({ orgId }, async (db) => {
    await db
      .update(domains)
      .set({ state: "removed", removedAt: new Date() })
      .where(kept)
    await syncTasks(db, orgId)
  })
}
