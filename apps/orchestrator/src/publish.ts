import {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalTarget,
  type FactRecord,
  parseSiteRevision,
  SITE_PROBE_HEADER,
  SITE_REVISION_HEADER,
  SitePointer,
  siteHost,
  siteUrl,
} from "@workspace/contracts"
import {
  appendEvent,
  approvals,
  assignments,
  chiefStaffId,
  deployments,
  eq,
  type OrgScopedDb,
  orgOpen,
  orgs,
  siteRevisions,
  sql,
  type Tenancy,
} from "@workspace/db"
import { checkBuild, checkContent, parsePage } from "@workspace/gates"
import {
  enteredFrom,
  type Ids,
  lockRow,
  TransitionError,
  transition,
} from "./state.ts"

/**
 * Publishing (ADR-032): an approval request written when a review starts, a
 * decision written once, and a `PublishWorkflow` per approval that re-reads
 * the decision, verifies the artifact, activates in one transaction, writes
 * the routing pointer and probes the live host, rolling back on a failure.
 * Rollback is the same Workflow without the approval and never moves an
 * assignment. The Workflow class is in cloudflare.ts with the others; every
 * step body is here. This is the only module that may touch the routing KV
 * binding; a test says so.
 */

/** How long an owner has to answer a review before the sweep parks it (§13). */
export const REVIEW_TTL_MS = 72 * 60 * 60 * 1000

const ACTION_KIND = "site.publish"

type ApprovalRow = typeof approvals.$inferSelect
type DeploymentRow = typeof deployments.$inferSelect

const toApprovalRequest = (row: ApprovalRow): ApprovalRequest =>
  ApprovalRequest.parse({
    approval_id: row.id,
    org_id: row.orgId,
    assignment_id: row.assignmentId,
    requested_by_staff_id: row.requestedByStaffId,
    approver_staff_id: row.approverStaffId,
    action_kind: row.actionKind,
    target: row.target,
    rationale: row.rationale,
    requested_at: row.requestedAt.toISOString(),
    expires_at: row.expiresAt.toISOString(),
  })

/** The event the `a11y` step logs a revision's accessibility gate in. */
export const A11Y_CHECKED = "revision.a11y_checked"

/**
 * Whether the revision passed the accessibility gate, which runs after its
 * preview exists. A revision from before that has the gate in its validation
 * report instead. No result is a refusal: the review, the approval and the
 * publish all wait on it.
 */
export async function accessible(
  db: OrgScopedDb,
  revisionId: string
): Promise<boolean> {
  const [row] = await db.execute<{ passed: boolean }>(
    sql`select true as passed from events e join site_revisions r on r.assignment_id = e.assignment_id where r.id = ${revisionId} and e.payload->>'revision_id' = ${revisionId} and ((e.type = ${A11Y_CHECKED} and e.payload->>'passed' = 'true') or (e.type = 'assignment.validation_reported' and e.payload->'gates' @> '[{"gate":"a11y","passed":true}]')) limit 1`
  )
  return row?.passed === true
}

/** Refuse a step that needs the revision's accessibility gate passed. */
async function needAccessible(db: OrgScopedDb, revisionId: string) {
  if (!(await accessible(db, revisionId))) {
    throw new TransitionError(
      "revision.a11y_unchecked",
      "validation",
      "the revision has no passing accessibility check yet"
    )
  }
}

/** The assignment's latest revision, whatever its status. */
export async function latestRevision(db: OrgScopedDb, assignmentId: string) {
  const [row] = await db
    .select()
    .from(siteRevisions)
    .where(eq(siteRevisions.assignmentId, assignmentId))
    .orderBy(sql`${siteRevisions.createdAt} desc`)
    .limit(1)
  return row ?? null
}

async function openRequest(db: OrgScopedDb, assignmentId: string) {
  const [row] = await db
    .select()
    .from(approvals)
    .where(
      sql`${approvals.assignmentId} = ${assignmentId} and ${approvals.decision} is null`
    )
    .limit(1)
  return row ?? null
}

/**
 * `POST /:id/review`: `preview_ready` to `awaiting_review` and an approval
 * request for the latest `preview` revision, expiring in 72 hours, in one
 * transaction. Asked twice, it answers the open request it already holds.
 */
export function requestReview(
  kit: Tenancy,
  ids: Ids
): Promise<{ request: ApprovalRequest; replayed: boolean }> {
  return kit.withOrg({ orgId: ids.orgId }, async (db) => {
    const row = await lockRow(db, ids.assignmentId)
    if (row.state === "awaiting_review") {
      const open = await openRequest(db, row.id)
      if (open) return { request: toApprovalRequest(open), replayed: true }
    }
    if (row.state !== "preview_ready") {
      throw new TransitionError(
        "assignment.not_previewable",
        "validation",
        `a review starts from preview_ready, not ${row.state}`
      )
    }
    const revision = await latestRevision(db, row.id)
    if (revision?.status !== "preview") {
      throw new TransitionError(
        "revision.not_preview",
        "validation",
        "the assignment's latest revision is not a preview"
      )
    }
    await needAccessible(db, revision.id)
    const chief = await chiefStaffId(db)
    const now = Date.now()
    const [inserted] = await db
      .insert(approvals)
      .values({
        orgId: row.orgId,
        assignmentId: row.id,
        requestedByStaffId: row.staffId,
        approverStaffId: chief ?? row.createdByStaffId,
        actionKind: ACTION_KIND,
        target: { kind: "revision", revision_id: revision.id },
        revisionId: revision.id,
        rationale: `Publish v${revision.version} of the site.`,
        requestedAt: new Date(now),
        expiresAt: new Date(now + REVIEW_TTL_MS),
      })
      .returning()
    if (!inserted) throw new Error("insert returned no row")
    const request = toApprovalRequest(inserted)
    await transition(db, {
      ...ids,
      to: "awaiting_review",
      expectedVersion: row.version,
      payload: { approval_id: request.approval_id },
    })
    await appendEvent(db, {
      orgId: row.orgId,
      assignmentId: row.id,
      staffId: row.staffId,
      type: "approval.requested",
      payload: request,
    })
    return { request, replayed: false }
  })
}

export type DecidedBy = ApprovalDecision["decided_by"]

/**
 * The open request a decision answers, with the assignment locked: from
 * `awaiting_review`, or from the park the sweep moves an unanswered review
 * into after 72 hours (§13), which is told apart from a budget park by the
 * state it was entered from. A request answered from the park may be past
 * its expiry: ADR-032 says a late approval still publishes and is still a
 * human act. From `awaiting_review` an expired request is still refused.
 */
async function openForDecision(
  db: OrgScopedDb,
  row: Awaited<ReturnType<typeof lockRow>>,
  revisionId: string
) {
  const parked =
    row.state === "blocked_on_approval" &&
    (await enteredFrom(db, row.id, "blocked_on_approval")) === "awaiting_review"
  if (row.state !== "awaiting_review" && !parked) {
    throw new TransitionError(
      "approval.not_requested",
      "validation",
      `a decision answers a review; the assignment is ${row.state}`
    )
  }
  const open = await openRequest(db, row.id)
  if (!open) {
    throw new TransitionError(
      "approval.not_requested",
      "validation",
      "no open approval request on this assignment"
    )
  }
  const target = ApprovalTarget.parse(open.target)
  if (target.kind !== "revision" || target.revision_id !== revisionId) {
    throw new TransitionError(
      "approval.target_mismatch",
      "validation",
      "the revision named is not the one the review was requested for"
    )
  }
  const expired = open.expiresAt.getTime() <= Date.now()
  if (expired && !parked) {
    throw new TransitionError(
      "approval.expired",
      "validation",
      "the review request has expired"
    )
  }
  return { open, expired }
}

/** A decision already written for this revision, so a repeated call replays it (R5). */
async function priorDecision(
  db: OrgScopedDb,
  assignmentId: string,
  revisionId: string,
  decision: "approved" | "rejected"
) {
  const [row] = await db
    .select()
    .from(approvals)
    .where(
      sql`${approvals.assignmentId} = ${assignmentId} and ${approvals.decision} = ${decision} and ${approvals.revisionId} = ${revisionId}`
    )
    .limit(1)
  return row ?? null
}

/**
 * `POST /:id/approve`: the decision, written once against the open request,
 * only when the revision the reviewer names is the request's target, with
 * `awaiting_review` (or the park) to `release_candidate` in the same
 * transaction. A second identical call replays the decision.
 */
export function decideApproval(
  kit: Tenancy,
  ids: Ids,
  input: { revisionId: string; decidedBy: DecidedBy }
): Promise<{ decision: ApprovalDecision; replayed: boolean }> {
  return kit.withOrg({ orgId: ids.orgId }, async (db) => {
    const row = await lockRow(db, ids.assignmentId)
    if (row.state === "release_candidate" || row.state === "published") {
      const decided = await priorDecision(
        db,
        row.id,
        input.revisionId,
        "approved"
      )
      if (decided) return { decision: toDecision(decided), replayed: true }
    }
    const { open, expired } = await openForDecision(db, row, input.revisionId)
    await needAccessible(db, input.revisionId)
    const decidedAt = new Date()
    const [decided] = await db
      .update(approvals)
      .set({
        decision: "approved",
        decidedBy: input.decidedBy,
        decidedAt,
      })
      .where(eq(approvals.id, open.id))
      .returning()
    if (!decided) throw new Error("the approval vanished under the lock")
    const decision = toDecision(decided)
    await transition(db, {
      ...ids,
      to: "release_candidate",
      expectedVersion: row.version,
      payload: { approval_id: decision.approval_id },
    })
    await appendEvent(db, {
      orgId: row.orgId,
      assignmentId: row.id,
      staffId: row.createdByStaffId,
      type: "approval.decided",
      payload: { ...decision, ...(expired ? { expired: true } : {}) },
    })
    return { decision, replayed: false }
  })
}

/**
 * `POST /:id/reject`: the other decision, written once against the same
 * open request under the same target check, and the build ends `cancelled`
 * with reason `review.rejected`, which releases the site lock and takes the
 * candidate into the seven-day window (ADR-031). No console gate: a
 * rejection publishes nothing.
 */
export function rejectApproval(
  kit: Tenancy,
  ids: Ids,
  input: { revisionId: string; decidedBy: DecidedBy }
): Promise<{ decision: ApprovalDecision; replayed: boolean }> {
  return kit.withOrg({ orgId: ids.orgId }, async (db) => {
    const row = await lockRow(db, ids.assignmentId)
    if (row.state === "cancelled") {
      const decided = await priorDecision(
        db,
        row.id,
        input.revisionId,
        "rejected"
      )
      if (decided) return { decision: toDecision(decided), replayed: true }
    }
    const { open } = await openForDecision(db, row, input.revisionId)
    const [decided] = await db
      .update(approvals)
      .set({
        decision: "rejected",
        decidedBy: input.decidedBy,
        decidedAt: new Date(),
      })
      .where(eq(approvals.id, open.id))
      .returning()
    if (!decided) throw new Error("the approval vanished under the lock")
    const decision = toDecision(decided)
    await transition(db, {
      ...ids,
      to: "cancelled",
      expectedVersion: row.version,
      reason: "review.rejected",
      payload: { approval_id: decision.approval_id },
    })
    await appendEvent(db, {
      orgId: row.orgId,
      assignmentId: row.id,
      staffId: row.createdByStaffId,
      type: "approval.decided",
      payload: decision,
    })
    return { decision, replayed: false }
  })
}

const toDecision = (row: ApprovalRow): ApprovalDecision =>
  ApprovalDecision.parse({
    approval_id: row.id,
    org_id: row.orgId,
    decision: row.decision,
    target: row.target,
    decided_by: row.decidedBy,
    decided_at: row.decidedAt?.toISOString(),
  })

/** The row a site serves now: the highest `config_version` (ADR-032). */
export async function activeDeployment(
  db: OrgScopedDb,
  siteId: string
): Promise<DeploymentRow | null> {
  const [row] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.siteId, siteId))
    .orderBy(sql`${deployments.configVersion} desc`)
    .limit(1)
  return row ?? null
}

/**
 * Activations and the checks of what is live take one transaction lock per
 * site, so a check and the event it writes see one state: an activation
 * either committed before the check or waits until after its write. The gates
 * step takes it too, so two passing revisions never read the same next version.
 */
export const lockSite = (db: OrgScopedDb, siteId: string) =>
  db.execute(sql`select pg_advisory_xact_lock(hashtext(${siteId}))`)

export type Activation = {
  /** The row's id, minted once per instance, so a retried step finds its own row and no other. */
  id: string
  siteId: string
  revisionId: string
  kind: "publish" | "rollback"
  approvalId?: string
  /** The assignment a publish moves to `published`; a rollback moves none. */
  assignmentId?: string
  reason?: string
  /** The deployment that must still be live, or nothing is activated: a rollback names the one it replaces. */
  over?: string
}

/**
 * Activation, one transaction (ADR-032): a `deployments` row under the
 * unique `(site_id, config_version)`, the revision marked `published`, and
 * for a publish the assignment moved to `published`. Retried after its
 * commit it finds the row it wrote, by its id, and returns it. `reme_app`
 * cannot update or delete a deployment, so a race is an insert conflict,
 * which is transient and retried. With `over`, another deployment live in
 * its place means null: the row read here is the one the insert's config
 * version follows, so the check cannot go stale.
 */
export async function activate(
  db: OrgScopedDb,
  orgId: string,
  input: Activation
): Promise<DeploymentRow | null> {
  await lockSite(db, input.siteId)
  const [mine] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, input.id))
  if (mine) return mine
  const active = await activeDeployment(db, input.siteId)
  if (input.over && active?.id !== input.over) return null
  if (active?.revisionId === input.revisionId) return active
  let inserted: DeploymentRow | undefined
  try {
    ;[inserted] = await db
      .insert(deployments)
      .values({
        id: input.id,
        orgId,
        siteId: input.siteId,
        revisionId: input.revisionId,
        previousRevisionId: active?.revisionId ?? null,
        configVersion: (active?.configVersion ?? 0) + 1,
        kind: input.kind,
        approvalId: input.approvalId ?? null,
        reason: input.reason ?? null,
      })
      .returning()
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause ?? error
    if (
      (cause as { constraint_name?: string }).constraint_name ===
      "deployments_site_config_version_key"
    ) {
      throw new TransitionError(
        "deployment.raced",
        "transient",
        "another activation took this config version"
      )
    }
    throw error
  }
  if (!inserted) throw new Error("insert returned no row")
  await db
    .update(siteRevisions)
    .set({ status: "published", updatedAt: new Date() })
    .where(eq(siteRevisions.id, input.revisionId))
  if (input.assignmentId) {
    const row = await lockRow(db, input.assignmentId)
    if (row.state === "release_candidate") {
      await transition(db, {
        orgId,
        assignmentId: row.id,
        to: "published",
        expectedVersion: row.version,
        payload: { deployment_id: inserted.id, revision_id: input.revisionId },
      })
    }
  }
  await appendEvent(db, {
    orgId,
    assignmentId: input.assignmentId ?? null,
    staffId: null,
    type: "deployment.activated",
    payload: {
      deployment_id: inserted.id,
      site_id: input.siteId,
      revision_id: input.revisionId,
      previous_revision_id: inserted.previousRevisionId,
      config_version: inserted.configVersion,
      kind: input.kind,
      reason: input.reason ?? null,
    },
  })
  return inserted
}

/**
 * Whether this instance's deployment is still the site's newest, read in the
 * step that acts on the answer. When it is not, a newer activation holds the
 * site: one `publish.superseded` event, the same wherever it is found, and
 * the instance neither alerts nor rolls back (ADR-032).
 */
export async function stillLive(
  db: OrgScopedDb,
  orgId: string,
  target: Pick<Target, "site_id" | "revision_id" | "assignment_id">,
  deploymentId: string | null,
  step: string
): Promise<boolean> {
  await lockSite(db, target.site_id)
  const live = await activeDeployment(db, target.site_id)
  if (live?.id === deploymentId) return true
  await appendEvent(db, {
    orgId,
    assignmentId: target.assignment_id,
    staffId: null,
    type: "publish.superseded",
    payload: {
      step,
      revision_id: target.revision_id,
      live_deployment_id: live?.id ?? null,
      live_revision_id: live?.revisionId ?? null,
    },
  })
  return false
}

/** The slice of R2 the publisher reads. */
export type Artifacts = {
  get: (
    key: string
  ) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | null>
}

/** Every file the manifest lists, present with its hash (§13 "Partial deployment"). */
export async function verifyArtifact(
  sites: Artifacts,
  siteId: string,
  revisionId: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const base = `sites/${siteId}/${revisionId}/`
  const stored = await sites.get(`${base}manifest.json`)
  if (!stored) return { ok: false, message: "the manifest is missing" }
  const manifest = JSON.parse(
    new TextDecoder().decode(await stored.arrayBuffer())
  )
  const result = await checkBuild(manifest, async (file) => {
    const object = await sites.get(`${base}dist/${file}`)
    return object ? new Uint8Array(await object.arrayBuffer()) : null
  })
  return result.passed
    ? { ok: true }
    : { ok: false, message: result.message ?? "the artifact is incomplete" }
}

/**
 * How long a probe waits for the router to serve its version: KV takes up to
 * a minute to reach every location and the router believes a pointer read
 * from Postgres for another. The worst case, every wait and every fetch,
 * stays inside Workflows' 10-minute step timeout; a test holds both bounds.
 */
export const SERVE_TRIES = 10
export const SERVE_WAIT_MS = 15_000
export const FETCH_TIMEOUT_MS = 10_000

/**
 * The live host's answer, judged the way the gates would (§11.1.7). With
 * `expected`, only a page the router tagged as this revision is judged. Any
 * other answer (an older deployment's page, an untagged 404, 429 or 503, a
 * fetch that fails) is waited out and asked again; a newer deployment's page
 * ends it at once. Either way the probe fails as `not_served`, never on
 * that answer.
 */
export async function probeHost(
  host: string,
  facts: readonly FactRecord[] | null,
  fetcher: typeof fetch = fetch,
  expected?: Pick<SitePointer, "revision_id" | "config_version"> & {
    /** `probeProof` for the host, without which the router names no revision. */
    proof: string
  },
  pause = (ms: number) => new Promise((done) => setTimeout(done, ms)),
  /** `SITE_PORT`: local dev's router, for a `.localhost` host. */
  port?: string
): Promise<{ ok: true } | { ok: false; reason: string; not_served?: string }> {
  let res: Response | null = null
  for (let attempt = 1; ; attempt++) {
    let seen: string
    try {
      res = await fetcher(`${siteUrl(host, port)}/`, {
        headers: {
          "cache-control": "no-cache",
          ...(expected && { [SITE_PROBE_HEADER]: expected.proof }),
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      const tag = res.headers.get(SITE_REVISION_HEADER)
      const served = parseSiteRevision(tag)
      if (!expected || served?.revision_id === expected.revision_id) break
      await res.body?.cancel()
      seen = tag ?? `untagged ${res.status}`
      if (served && served.config_version > expected.config_version) {
        return { ok: false, reason: `served ${seen}`, not_served: seen }
      }
    } catch (error) {
      seen = `fetch failed: ${(error as Error).message}`
      if (!expected) return { ok: false, reason: seen }
    }
    if (attempt >= SERVE_TRIES) {
      return { ok: false, reason: `served ${seen}`, not_served: seen }
    }
    await pause(SERVE_WAIT_MS)
  }
  if (res.status !== 200) return { ok: false, reason: `status ${res.status}` }
  const html = await res.text()
  const text = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!/<title>[^<]+<\/title>/i.test(html) || text.length < 50) {
    return { ok: false, reason: "blank page" }
  }
  if (facts) {
    const content = checkContent([parsePage("index.html", html)], facts, [host])
    if (!content.passed) {
      return { ok: false, reason: content.message ?? "content gate failed" }
    }
  }
  return { ok: true }
}

/** Minutes after activation at which the live host is probed (ADR-032). */
export const PROBE_MINUTES = [0, 2, 5, 10] as const

/**
 * A queued site assignment whose instance has ended without the site lock
 * is given a new instance (the previous one cannot be recreated under its
 * id). Called after a step that ends a lock holder, and by the hourly sweep.
 */
export async function redriveQueued(
  env: Pick<Env, "ASSIGNMENTS">,
  kit: Tenancy,
  orgId: string
): Promise<string[]> {
  const rows = await kit.withOrg({ orgId }, (db) =>
    db
      .select({
        id: assignments.id,
        instance: assignments.workflowInstanceId,
      })
      .from(assignments)
      .where(
        sql`${assignments.state} = 'queued' and ${assignments.kind} like 'site.%'`
      )
  )
  const redriven: string[] = []
  for (const row of rows) {
    if (row.instance) {
      let status: string | null = null
      try {
        status = (await (await env.ASSIGNMENTS.get(row.instance)).status())
          .status
      } catch {
        status = null
      }
      if (
        status &&
        ["queued", "running", "waiting", "waitingForPause", "paused"].includes(
          status
        )
      ) {
        continue
      }
    }
    const attempt = Number(row.instance?.match(/-r(\d+)$/)?.[1] ?? 0) + 1
    const id = `${row.id}-r${attempt}`
    try {
      await env.ASSIGNMENTS.create({
        id,
        params: { assignment_id: row.id, org_id: orgId },
      })
    } catch {
      // Already created by a concurrent redrive; the row says which instance won.
      continue
    }
    await kit.withOrg({ orgId }, async (db) => {
      await db
        .update(assignments)
        .set({ workflowInstanceId: id })
        .where(eq(assignments.id, row.id))
      await appendEvent(db, {
        orgId,
        assignmentId: row.id,
        staffId: null,
        type: "assignment.redriven",
        payload: { instance_id: id, attempt },
      })
    })
    redriven.push(row.id)
  }
  return redriven
}

/** R8: ids only. A publish names its approval; a rollback names its site and the request that asked. */
export type PublishParams =
  | { org_id: string; approval_id: string }
  | {
      org_id: string
      site_id: string
      rollback: { key: string; reason: string }
    }

export type Target = {
  site_id: string
  revision_id: string
  assignment_id: string | null
  host: string
  /** The deployment a rollback replaces, read with its target; null for a publish. */
  live_deployment_id: string | null
}

/**
 * What a publish or a rollback activates, re-read from the rows and never
 * trusted from the request that created the instance: the approval, its
 * target, the assignment's current revision and who decided all have to
 * agree (§8.4, ADR-032). Every refusal is `validation`, so the Workflow
 * ends rather than retries.
 */
export async function readTarget(
  db: OrgScopedDb,
  env: Pick<Env, "SITE_HOST_SUFFIX" | "CONSOLE_APPROVALS">,
  params: PublishParams
): Promise<Target> {
  const refuse = (code: string) => new TransitionError(code, "validation", code)
  const [org] = await db
    .select({ slug: orgs.slug })
    .from(orgs)
    .where(eq(orgs.id, params.org_id))
  if (!org) throw refuse("org.not_found")
  const host = siteHost(org.slug, env.SITE_HOST_SUFFIX)
  if ("rollback" in params) {
    const active = await activeDeployment(db, params.site_id)
    if (!active?.previousRevisionId) throw refuse("rollback.nothing_previous")
    return {
      site_id: params.site_id,
      revision_id: active.previousRevisionId,
      assignment_id: null,
      host,
      live_deployment_id: active.id,
    }
  }
  const [approval] = await db
    .select()
    .from(approvals)
    .where(eq(approvals.id, params.approval_id))
  if (approval?.decision !== "approved") {
    throw refuse("approval.not_approved")
  }
  const decision = toDecision(approval)
  if (
    decision.decided_by.kind === "console" &&
    env.CONSOLE_APPROVALS !== "allow"
  ) {
    throw refuse("approval.console_forbidden")
  }
  if (decision.target.kind !== "revision" || !approval.assignmentId) {
    throw refuse("approval.target_unsupported")
  }
  const [row] = await db
    .select()
    .from(assignments)
    .where(eq(assignments.id, approval.assignmentId))
  const latest = await latestRevision(db, approval.assignmentId)
  if (!row || !latest) throw refuse("assignment.not_found")
  if (latest.id !== decision.target.revision_id) throw refuse("approval.stale")
  if (row.state !== "release_candidate" && row.state !== "published") {
    throw refuse("assignment.not_release_candidate")
  }
  return {
    site_id: latest.siteId,
    revision_id: latest.id,
    assignment_id: row.id,
    host,
    live_deployment_id: null,
  }
}

/**
 * The routing pointer (§11.1.3): KV is the cache and Postgres the truth, so
 * every write puts the site's newest deployment as Postgres has it now, and a
 * late or retried write can only repeat what is live. An org whose account
 * was deleted gets no pointer at all (ADR-035), and the refusal is final. The
 * KV write follows the read's commit rather than running inside it, so no
 * transaction is held open on KV.
 */
export async function writePointer(
  env: Pick<Env, "ROUTES">,
  kit: Pick<Tenancy, "withOrg">,
  orgId: string,
  siteId: string,
  host: string
): Promise<{ host: string }> {
  const live = await kit.withOrg({ orgId }, async (db) =>
    (await orgOpen(db)) ? activeDeployment(db, siteId) : "closed"
  )
  if (live === "closed") {
    throw new TransitionError("org.closed", "resource", "the org is closed")
  }
  if (!live) throw new Error("no deployment to point at")
  await env.ROUTES.put(
    `host:${host}`,
    JSON.stringify(
      SitePointer.parse({
        org_id: orgId,
        site_id: siteId,
        revision_id: live.revisionId,
        config_version: live.configVersion,
      })
    )
  )
  return { host }
}

/**
 * Every pointer the org's site answers on, gone (ADR-035): its one live host
 * (ADR-030). Previews carry signed claims, not pointers, and the router
 * refuses those itself for a closed org. Deleting a key that is not there is
 * success, so a repeat is too.
 */
export async function clearPointers(
  env: Pick<Env, "ROUTES" | "SITE_HOST_SUFFIX">,
  kit: Pick<Tenancy, "withOrg">,
  orgId: string
): Promise<void> {
  const [org] = await kit.withOrg({ orgId }, (db) =>
    db.select({ slug: orgs.slug }).from(orgs).where(eq(orgs.id, orgId))
  )
  if (org)
    await env.ROUTES.delete(`host:${siteHost(org.slug, env.SITE_HOST_SUFFIX)}`)
}
