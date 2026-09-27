import {
  CompletionReport,
  type FactRecord,
  FactSnapshot,
  type GateResult,
  InformationAnswer,
  ValidationReport,
} from "@workspace/contracts"
import {
  appendEvent,
  assignments,
  eq,
  events,
  facts,
  orgs,
  siteRevisions,
  sql,
  type Tenancy,
  toFactRecord,
} from "@workspace/db"
import { runGates } from "@workspace/gates"
import { siteHost } from "./seed.ts"
import { type Ids, TransitionError, transition } from "./state.ts"

/** The slice of the R2 binding the gates step reads and writes. */
export type Artifacts = {
  get: (
    key: string
  ) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | null>
  put: (key: string, value: string) => Promise<unknown>
}

/**
 * The facts an assignment's claims are judged against: the snapshot it was
 * briefed with plus the facts its answers produced, both read from the log,
 * so the validating step and the publisher's probes agree.
 */
export async function assignmentFacts(
  kit: Tenancy,
  ids: Ids
): Promise<FactRecord[]> {
  const { row, logged } = await kit.withOrg(
    { orgId: ids.orgId },
    async (db) => {
      const [found] = await db
        .select()
        .from(assignments)
        .where(eq(assignments.id, ids.assignmentId))
      const events_ = await db
        .select({ type: events.type, payload: events.payload })
        .from(events)
        .where(
          sql`${events.assignmentId} = ${ids.assignmentId} and ${events.type} in ('facts.snapshot_taken', 'information.answered')`
        )
        .orderBy(events.eventId)
      return { row: found ?? null, logged: events_ }
    }
  )
  if (!row)
    throw new TransitionError(
      "assignment.not_found",
      "resource",
      "no assignment to read facts for"
    )
  const snapshotEvent = logged.find(
    (e) =>
      e.type === "facts.snapshot_taken" &&
      e.payload.snapshot_id === row.factSnapshotId
  )
  if (!snapshotEvent)
    throw new TransitionError(
      "snapshot.not_found",
      "validation",
      "the briefed snapshot is not in the log"
    )
  const { withheld: _withheld, ...snapshotBody } = snapshotEvent.payload
  const snapshot = FactSnapshot.parse(snapshotBody)
  const answeredIds = logged
    .filter((e) => e.type === "information.answered")
    .map((e) => InformationAnswer.parse(e.payload).fact_id)
  const answered: FactRecord[] =
    answeredIds.length === 0
      ? []
      : await kit.withOrg({ orgId: ids.orgId }, async (db) =>
          (
            await db
              .select()
              .from(facts)
              .where(
                sql`${facts.id} in (${sql.join(
                  answeredIds.map((id) => sql`${id}`),
                  sql`, `
                )})`
              )
          ).map(toFactRecord)
        )
  return [...snapshot.facts, ...answered]
}

export type Verdict =
  | { outcome: "preview_ready"; report_id: string }
  | { outcome: "repairing"; report_id: string; failed: GateResult[] }
  | { outcome: "failed"; report_id: string; failed: GateResult[] }

/**
 * The `validating` step (§8.5, ADR-032): the gates run here, outside the
 * sandbox, against the artifact in R2. The facts are the snapshot the
 * assignment was briefed with plus the facts its answers produced, both read
 * from the log, so re-running gives the same answer. A pass moves the
 * assignment to `preview_ready`; a failure moves it through `repairing` back to
 * `implementing` for the Developer to fix, and once the repair budget is spent
 * the failure ends in `failed`. Each outcome is one transaction. The site's
 * own host, from the org's slug and the environment's host suffix, is not
 * read as copy; a suffix that is missing or malformed throws.
 */
export async function validateRevision(
  kit: Tenancy,
  sites: Artifacts,
  ids: Ids,
  input: { report_id: string; revision_id: string },
  hostSuffix: string
): Promise<Verdict> {
  const loaded = await kit.withOrg({ orgId: ids.orgId }, async (db) => {
    const [row] = await db
      .select()
      .from(assignments)
      .where(eq(assignments.id, ids.assignmentId))
    const [revision] = await db
      .select()
      .from(siteRevisions)
      .where(eq(siteRevisions.id, input.revision_id))
    if (!row || !revision) return null
    const [org] = await db
      .select({ slug: orgs.slug })
      .from(orgs)
      .where(eq(orgs.id, ids.orgId))
    const logged = await db
      .select({ type: events.type, payload: events.payload })
      .from(events)
      .where(
        sql`${events.assignmentId} = ${ids.assignmentId} and ${events.type} in ('facts.snapshot_taken', 'information.answered', 'assignment.completion_reported', 'assignment.validation_reported')`
      )
      .orderBy(events.eventId)
    return { row, revision, logged, slug: org?.slug }
  })
  if (!loaded)
    throw new TransitionError(
      "assignment.not_found",
      "resource",
      "no assignment or revision to validate"
    )
  const { row, revision, logged, slug } = loaded

  // A retried step after its transaction committed: answer with what it decided.
  if (row.state !== "validating")
    return recordedVerdict(row.state, logged, input.revision_id)

  const factsUsed = await assignmentFacts(kit, ids)
  const reportEvent = logged.find(
    (e) =>
      e.type === "assignment.completion_reported" &&
      e.payload.report_id === input.report_id
  )
  if (!reportEvent)
    throw new TransitionError(
      "report.not_found",
      "validation",
      "the completion report is not in the log"
    )
  const report = CompletionReport.parse(reportEvent.payload)

  const base = revision.manifestKey.replace(/manifest\.json$/, "")
  const manifestObject = await sites.get(revision.manifestKey)
  const manifest = manifestObject
    ? JSON.parse(new TextDecoder().decode(await manifestObject.arrayBuffer()))
    : null
  const results = await runGates({
    manifest,
    read: async (file) => {
      const object = await sites.get(`${base}dist/${file}`)
      return object ? new Uint8Array(await object.arrayBuffer()) : null
    },
    report,
    facts: factsUsed,
    hosts: [siteHost(slug ?? "", hostSuffix)],
  })

  const gates: GateResult[] = []
  for (const result of results) {
    const key = `${base}gates/${result.gate}.json`
    await sites.put(key, JSON.stringify(result))
    gates.push({ ...result, evidence_key: result.evidence_key ?? key })
  }
  const validation = ValidationReport.parse({
    report_id: crypto.randomUUID(),
    org_id: ids.orgId,
    assignment_id: ids.assignmentId,
    revision_id: input.revision_id,
    gates,
    produced_at: new Date().toISOString(),
  })
  const failed = gates.filter((g) => !g.passed)

  return kit.withOrg({ orgId: ids.orgId }, async (db) => {
    const [fresh] = await db
      .select({ version: assignments.version })
      .from(assignments)
      .where(eq(assignments.id, ids.assignmentId))
    const version = fresh?.version ?? row.version
    // `offending_node` quotes model output, so nothing downstream may promote it (§28.3).
    await appendEvent(db, {
      orgId: ids.orgId,
      assignmentId: ids.assignmentId,
      staffId: null,
      type: "assignment.validation_reported",
      payload: validation,
      taint: failed.length > 0 ? ["inferred"] : [],
    })
    const payload = {
      report_id: validation.report_id,
      revision_id: input.revision_id,
    }
    // Every revision carries the Developer's own summary from here on, the
    // ones that never publish included (ADR-031); a pass also makes it the
    // preview.
    await db
      .update(siteRevisions)
      .set({
        summary: summaryOf(report),
        ...(failed.length === 0 ? { status: "preview" as const } : {}),
        updatedAt: new Date(),
      })
      .where(eq(siteRevisions.id, input.revision_id))
    if (failed.length === 0) {
      await transition(db, {
        ...ids,
        to: "preview_ready",
        expectedVersion: version,
        payload,
      })
      return {
        outcome: "preview_ready",
        report_id: validation.report_id,
      } as const
    }
    try {
      const repair = await transition(db, {
        ...ids,
        to: "repairing",
        expectedVersion: version,
        reason: "gates.failed",
        payload,
      })
      await transition(db, {
        ...ids,
        to: "implementing",
        expectedVersion: repair.version,
        payload,
      })
      return {
        outcome: "repairing",
        report_id: validation.report_id,
        failed,
      } as const
    } catch (error) {
      // The budget check runs before any write, so the transaction is still whole.
      if (
        !(error instanceof TransitionError) ||
        error.code !== "assignment.repair_budget_exhausted"
      )
        throw error
      await transition(db, {
        ...ids,
        to: "failed",
        expectedVersion: version,
        reason: "gates.repair_budget_exhausted",
        payload,
      })
      return {
        outcome: "failed",
        report_id: validation.report_id,
        failed,
      } as const
    }
  })
}

/** The change summary a kept revision carries: the reasons, or the report's one line. */
export const summaryOf = (
  report: Pick<CompletionReport, "changes" | "summary">
) =>
  report.changes.length > 0
    ? report.changes.map((c) => c.reason).join("; ")
    : report.summary

function recordedVerdict(
  state: string,
  logged: { type: string; payload: Record<string, unknown> }[],
  revisionId: string
): Verdict {
  const last = [...logged]
    .reverse()
    .find(
      (e) =>
        e.type === "assignment.validation_reported" &&
        e.payload.revision_id === revisionId
    )
  if (!last)
    throw new TransitionError(
      "assignment.not_validating",
      "validation",
      `the assignment is ${state}, not validating`
    )
  const report = ValidationReport.parse(last.payload)
  const failed = report.gates.filter((g) => !g.passed)
  if (state === "preview_ready" && failed.length === 0)
    return { outcome: "preview_ready", report_id: report.report_id }
  if (state === "failed")
    return { outcome: "failed", report_id: report.report_id, failed }
  return { outcome: "repairing", report_id: report.report_id, failed }
}
