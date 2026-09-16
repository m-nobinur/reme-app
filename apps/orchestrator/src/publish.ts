import {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalTarget,
  type FactRecord,
  SitePointer,
} from "@workspace/contracts"
import {
  approvals,
  assignments,
  deployments,
  eq,
  type OrgScopedDb,
  orgs,
  siteRevisions,
  sql,
  staff,
  type Tenancy,
} from "@workspace/db"
import { checkBuild, checkContent, parsePage } from "@workspace/gates"
import { siteHost } from "./seed.ts"
import {
  appendEvent,
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

/** The assignment's latest revision, whatever its status. */
export async function latestRevision(db: OrgScopedDb, assignmentId: string) {
  const [row] = await db
    .select()
    .from(siteRevisions)
    .where(eq(siteRevisions.assignmentId, assignmentId))
    .orderBy(sql`${siteRevisions.version} desc`)
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
    const [chief] = await db
      .select({ id: staff.id })
      .from(staff)
      .where(eq(staff.staffCode, "COS-001"))
    const now = Date.now()
    const [inserted] = await db
      .insert(approvals)
      .values({
        orgId: row.orgId,
        assignmentId: row.id,
        requestedByStaffId: row.staffId,
        approverStaffId: chief?.id ?? row.createdByStaffId,
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
 * `POST /:id/approve`: the decision, written once against the open request,
 * only when the revision the reviewer names is the request's target and the
 * request has not expired, with `awaiting_review` to `release_candidate` in
 * the same transaction. A second identical call replays the decision.
 */
export function decideApproval(
  kit: Tenancy,
  ids: Ids,
  input: { revisionId: string; decidedBy: DecidedBy }
): Promise<{ decision: ApprovalDecision; replayed: boolean }> {
  return kit.withOrg({ orgId: ids.orgId }, async (db) => {
    const row = await lockRow(db, ids.assignmentId)
    if (row.state === "release_candidate" || row.state === "published") {
      const [decided] = await db
        .select()
        .from(approvals)
        .where(
          sql`${approvals.assignmentId} = ${row.id} and ${approvals.decision} = 'approved' and ${approvals.revisionId} = ${input.revisionId}`
        )
        .limit(1)
      if (decided) return { decision: toDecision(decided), replayed: true }
    }
    if (row.state !== "awaiting_review") {
      throw new TransitionError(
        "approval.not_requested",
        "validation",
        `an approval answers a review; the assignment is ${row.state}`
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
    if (target.kind !== "revision" || target.revision_id !== input.revisionId) {
      throw new TransitionError(
        "approval.target_mismatch",
        "validation",
        "the revision named is not the one the review was requested for"
      )
    }
    if (open.expiresAt.getTime() <= Date.now()) {
      throw new TransitionError(
        "approval.expired",
        "validation",
        "the review request has expired"
      )
    }
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

export type Activation = {
  siteId: string
  revisionId: string
  kind: "publish" | "rollback"
  approvalId?: string
  /** The assignment a publish moves to `published`; a rollback moves none. */
  assignmentId?: string
  reason?: string
}

/**
 * Activation, one transaction (ADR-032): a `deployments` row under the
 * unique `(site_id, config_version)`, the revision marked `published`, and
 * for a publish the assignment moved to `published`. Retried after its
 * commit it finds the row it wrote and returns it. `reme_app` cannot update
 * or delete a deployment, so a race is an insert conflict, which is
 * transient and retried.
 */
export async function activate(
  db: OrgScopedDb,
  orgId: string,
  input: Activation
): Promise<DeploymentRow> {
  const active = await activeDeployment(db, input.siteId)
  if (active?.revisionId === input.revisionId) return active
  let inserted: DeploymentRow | undefined
  try {
    ;[inserted] = await db
      .insert(deployments)
      .values({
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

/** The live host's answer, judged the way the gates would (§11.1.7). */
export async function probeHost(
  host: string,
  facts: readonly FactRecord[] | null,
  fetcher: typeof fetch = fetch
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let res: Response
  try {
    res = await fetcher(`https://${host}/`, {
      headers: { "cache-control": "no-cache" },
    })
  } catch (error) {
    return { ok: false, reason: `fetch failed: ${(error as Error).message}` }
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
    const content = checkContent([parsePage("index.html", html)], facts)
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
  previous_revision_id: string | null
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
      previous_revision_id: active.revisionId,
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
  const active = await activeDeployment(db, latest.siteId)
  return {
    site_id: latest.siteId,
    revision_id: latest.id,
    assignment_id: row.id,
    host,
    previous_revision_id: active?.revisionId ?? null,
  }
}

/**
 * The routing pointer (§11.1.3): KV is the cache and this row is what the
 * router serves. The binding is optional in the generated types because
 * production has no namespace yet; a publish without one is a configuration
 * error, not a retry.
 */
export async function writePointer(
  env: Pick<Env, "ROUTES">,
  host: string,
  pointer: SitePointer
): Promise<{ host: string }> {
  if (!env.ROUTES)
    throw new TransitionError("routes.unbound", "resource", "no ROUTES binding")
  await env.ROUTES.put(
    `host:${host}`,
    JSON.stringify(SitePointer.parse(pointer))
  )
  return { host }
}
