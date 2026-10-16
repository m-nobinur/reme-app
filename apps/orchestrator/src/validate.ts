import {
  Blueprint,
  CompletionReport,
  type FactRecord,
  FactSnapshot,
  type GateResult,
  InformationAnswer,
  siteHost,
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
import { checkAxe, parseAxe, runGates } from "@workspace/gates"
import budget from "@workspace/starter-site/size-budget.json"
import { A11Y_CHECKED, lockSite } from "./publish.ts"
import { type Ids, lockRow, TransitionError, transition } from "./state.ts"

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

/** The planned build's slots and pages for the claims gate; nothing for a build that did not plan. */
const planned = (blueprint: unknown) => {
  const plan = Blueprint.safeParse(blueprint)
  return plan.success
    ? { plan: { images: plan.data.images, pages: plan.data.pages } }
    : {}
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
  input: {
    report_id: string
    revision_id: string
    /** `"later"`: the quick lane checks it after the preview (`checkA11y`). */
    axe: AxeRun | null | "later"
  },
  hostSuffix: string,
  /** Filled with milliseconds per gate for the timing line. */
  timings?: Record<string, number>
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

  // The facts and the manifest are independent reads: one database, one bucket.
  const base = revision.manifestKey.replace(/manifest\.json$/, "")
  const [factsUsed, manifestObject] = await Promise.all([
    assignmentFacts(kit, ids),
    sites.get(revision.manifestKey),
  ])
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

  const manifest = manifestObject
    ? JSON.parse(new TextDecoder().decode(await manifestObject.arrayBuffer()))
    : null
  const bytesOf = async (key: string) => {
    const object = await sites.get(key)
    return object ? new Uint8Array(await object.arrayBuffer()) : null
  }
  // The accessibility gate is axe's own run in the sandbox, handed in by the
  // Workflow, which ran it while the critic read the screenshots. It gates the
  // first preview, so a build never announces one and then repairs it. A quick
  // edit has nothing to hide axe behind, so it runs after the preview.
  const results = [
    ...(
      await runGates({
        manifest,
        read: (file) => bytesOf(`${base}dist/${file}`),
        evidence: bytesOf,
        // The starter's line for the home page; its baseline is the starter's own.
        budget: { limit: budget.limit },
        report,
        facts: factsUsed,
        hosts: [siteHost(slug ?? "", hostSuffix)],
        timings,
        ...planned(row.blueprint),
      })
    ).filter((result) => result.gate !== "a11y"),
    ...(input.axe === "later" ? [] : [await axeGate(sites, input.axe)]),
  ]

  const gates: GateResult[] = await Promise.all(
    results.map(async (result) => {
      const key = `${base}gates/${result.gate}.json`
      await sites.put(key, JSON.stringify(result))
      return { ...result, evidence_key: result.evidence_key ?? key }
    })
  )
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
    // ones that never publish included (ADR-031). A pass also makes it the
    // preview and gives it the site's next number, under the site's lock, so
    // the versions the owner sees count only what passed and have no gaps.
    if (failed.length === 0) await lockSite(db, revision.siteId)
    await db
      .update(siteRevisions)
      .set({
        summary: summaryOf(report),
        ...(failed.length === 0
          ? {
              status: "preview" as const,
              version: sql`(select coalesce(max(${siteRevisions.version}), 0) + 1 from ${siteRevisions} where ${siteRevisions.siteId} = ${revision.siteId})`,
            }
          : {}),
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

/** A sandbox script's run, as `runAxe` reports it. */
type AxeRun = { exit_code: number; key: string | null }

/**
 * The accessibility gate (§8.5): axe ran in the sandbox over the built site
 * before the preview exists, and its JSON is the evidence. `axe` is null when
 * the site's sandbox went to a newer edit first: nothing ran, nothing passed.
 * The JSON is the sandbox's, so unreadable is the same as absent, which fails.
 */
async function axeGate(sites: Artifacts, axe: AxeRun | null) {
  if (!axe)
    return {
      gate: "a11y" as const,
      passed: false,
      evidence_key: null,
      offending_node: null,
      message: "axe did not run: a newer edit took the site's sandbox first",
    }
  const evidence = axe.key ? await sites.get(axe.key) : null
  let result: ReturnType<typeof parseAxe> = null
  try {
    result = evidence
      ? parseAxe(
          JSON.parse(new TextDecoder().decode(await evidence.arrayBuffer()))
        )
      : null
  } catch {
    // Left null: the gate fails on it.
  }
  return checkAxe(
    {
      checks: [{ check: "axe", exit_code: axe.exit_code, output_key: axe.key }],
    },
    result
  )
}

/** What the `a11y` step decided: a gate verdict, or nothing to do for a build that moved on. */
type A11yVerdict = Verdict | { outcome: "stopped" }

/**
 * A quick edit's accessibility gate, once its preview exists: axe ran in the
 * sandbox after `preview_ready`, so the preview does not wait on it. The
 * result is logged against the revision, which the review, the approval and
 * the publisher refuse without. A failure sends a preview that is still
 * `preview_ready` back through `repairing`, as a failure in `validating`
 * does, or to `failed` once the repairs are spent. `axe` is null when the
 * site's sandbox went to a newer edit first: nothing ran, nothing passed. A
 * retried step answers with what it logged the first time.
 */
export async function checkA11y(
  kit: Tenancy,
  sites: Artifacts,
  ids: Ids,
  revisionId: string,
  axe: AxeRun | null
): Promise<A11yVerdict> {
  const gate: GateResult = await axeGate(sites, axe)
  const reportId = crypto.randomUUID()
  await sites.put(
    `sites/${ids.orgId}/${revisionId}/gates/a11y.json`,
    JSON.stringify(gate)
  )
  return kit.withOrg({ orgId: ids.orgId }, async (db) => {
    const row = await lockRow(db, ids.assignmentId)
    const [logged] = await db
      .select({ payload: events.payload })
      .from(events)
      .where(
        sql`${events.assignmentId} = ${ids.assignmentId} and ${events.type} = ${A11Y_CHECKED} and ${events.payload}->>'revision_id' = ${revisionId}`
      )
      .limit(1)
    if (logged) {
      const was = logged.payload as GateResult & { report_id: string }
      const failed = was.passed ? [] : [was]
      if (was.passed)
        return { outcome: "preview_ready", report_id: was.report_id }
      if (row.state === "implementing")
        return { outcome: "repairing", report_id: was.report_id, failed }
      if (row.state === "failed")
        return { outcome: "failed", report_id: was.report_id, failed }
      return { outcome: "stopped" }
    }
    // `offending_node` quotes model output, so nothing downstream may promote it (§28.3).
    await appendEvent(db, {
      orgId: ids.orgId,
      assignmentId: ids.assignmentId,
      staffId: null,
      type: A11Y_CHECKED,
      payload: { ...gate, report_id: reportId, revision_id: revisionId },
      taint: gate.passed ? [] : ["inferred"],
    })
    if (gate.passed) return { outcome: "preview_ready", report_id: reportId }
    if (!axe || row.state !== "preview_ready") return { outcome: "stopped" }
    const payload = { report_id: reportId, revision_id: revisionId }
    try {
      const repair = await transition(db, {
        ...ids,
        to: "repairing",
        expectedVersion: row.version,
        reason: "gates.failed",
        payload,
      })
      await transition(db, {
        ...ids,
        to: "implementing",
        expectedVersion: repair.version,
        payload,
      })
      return { outcome: "repairing", report_id: reportId, failed: [gate] }
    } catch (error) {
      if (
        !(error instanceof TransitionError) ||
        error.code !== "assignment.repair_budget_exhausted"
      )
        throw error
      await transition(db, {
        ...ids,
        to: "failed",
        expectedVersion: row.version,
        reason: "gates.repair_budget_exhausted",
        payload,
      })
      return { outcome: "failed", report_id: reportId, failed: [gate] }
    }
  })
}

/** The change summary a kept revision carries: the reasons, or the report's one line. */
const summaryOf = (report: Pick<CompletionReport, "changes" | "summary">) =>
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
